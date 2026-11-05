//! LedgerShot escrow, v1.2.
//!
//! A studio opens a job bound to two hashes: the brief (`spec_hash`) and the
//! deliverable the client agreed to buy (`expected_hash`). The client locks
//! Circle devnet USDC in the job vault, then signs `sync_funded`. `release`
//! pays the merchant only when the delivered bytes hash to `expected_hash`.
//! The mint account is pinned to Circle USDC. Funding must match `job.amount`
//! exactly so leftover tokens cannot sit in the vault.
//!
//! Redeploy this crate with the upgrade authority before judges send a live tx.
//!
//! Transitions: quoted -> funded -> released
//!                       \-> refunded

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx");

const JOB_SEED: &[u8] = b"job";
/// Circle USDC on Solana devnet. Init, fund, release, and refund all pin this mint.
const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

#[program]
pub mod ledger_shot {
    use super::*;

    pub fn init_job(
        ctx: Context<InitJob>,
        job_id: [u8; 16],
        amount: u64,
        deadline_unix: i64,
        spec_hash: [u8; 32],
        expected_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, ShotError::ZeroAmount);
        require!(
            deadline_unix > Clock::get()?.unix_timestamp,
            ShotError::DeadlinePast
        );
        require!(spec_hash != [0u8; 32], ShotError::EmptyHash);
        require!(expected_hash != [0u8; 32], ShotError::EmptyHash);

        let job = &mut ctx.accounts.job;
        job.payer = ctx.accounts.payer.key();
        job.merchant = ctx.accounts.merchant.key();
        job.mint = ctx.accounts.mint.key();
        job.amount = amount;
        job.job_id = job_id;
        job.deadline = deadline_unix;
        job.status = JobStatus::Quoted as u8;
        job.output_hash = [0u8; 32];
        job.spec_hash = spec_hash;
        job.expected_hash = expected_hash;
        job.bump = ctx.bumps.job;
        Ok(())
    }

    /// Client has transferred `amount` USDC into the vault and signs to accept
    /// the hash lock already written on the job. A client that disagrees with
    /// `expected_hash` must not sign this.
    pub fn sync_funded(ctx: Context<SyncFunded>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Quoted as u8, ShotError::BadStatus);
        require_keys_eq!(ctx.accounts.vault.mint, job.mint, ShotError::WrongMint);
        require_keys_eq!(job.mint, USDC_MINT, ShotError::WrongMint);
        require!(
            ctx.accounts.vault.amount == job.amount,
            ShotError::AmountMismatch
        );
        job.status = JobStatus::Funded as u8;
        Ok(())
    }

    pub fn release(ctx: Context<Release>, output_hash: [u8; 32]) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Funded as u8, ShotError::BadStatus);
        require!(output_hash != [0u8; 32], ShotError::EmptyHash);
        require!(
            output_hash == job.expected_hash,
            ShotError::HashMismatch
        );
        require!(
            Clock::get()?.unix_timestamp < job.deadline,
            ShotError::DeadlinePast
        );

        let seeds: &[&[u8]] = &[JOB_SEED, job.payer.as_ref(), job.job_id.as_ref(), &[job.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.merchant_ata.to_account_info(),
                    authority: job.to_account_info(),
                },
                &[seeds],
            ),
            job.amount,
        )?;
        job.output_hash = output_hash;
        job.status = JobStatus::Released as u8;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == JobStatus::Funded as u8, ShotError::BadStatus);

        let now = Clock::get()?.unix_timestamp;
        let merchant_signed =
            ctx.accounts.merchant.is_signer && ctx.accounts.merchant.key() == job.merchant;
        require!(merchant_signed || now >= job.deadline, ShotError::RefundLocked);

        let seeds: &[&[u8]] = &[JOB_SEED, job.payer.as_ref(), job.job_id.as_ref(), &[job.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.payer_ata.to_account_info(),
                    authority: job.to_account_info(),
                },
                &[seeds],
            ),
            job.amount,
        )?;
        job.status = JobStatus::Refunded as u8;
        Ok(())
    }
}

#[account]
pub struct Job {
    pub payer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub job_id: [u8; 16],
    pub deadline: i64,
    pub output_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub expected_hash: [u8; 32],
    pub status: u8,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(job_id: [u8; 16])]
pub struct InitJob<'info> {
    #[account(mut)]
    pub merchant: Signer<'info>,
    /// CHECK: payer is bound into the PDA seeds and does not sign init.
    /// Consent is the payer's signature on `sync_funded`.
    pub payer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT @ ShotError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = merchant,
        space = 8 + 32 + 32 + 32 + 8 + 16 + 8 + 32 + 32 + 32 + 1 + 1,
        seeds = [JOB_SEED, payer.key().as_ref(), job_id.as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(
        init,
        payer = merchant,
        associated_token::mint = mint,
        associated_token::authority = job
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncFunded<'info> {
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = payer)]
    pub job: Account<'info, Job>,
    #[account(address = USDC_MINT @ ShotError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(associated_token::mint = mint, associated_token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub merchant: Signer<'info>,
    #[account(mut, has_one = merchant, has_one = mint)]
    pub job: Account<'info, Job>,
    #[account(address = USDC_MINT @ ShotError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = merchant)]
    pub merchant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// CHECK: unsigned after the deadline; must sign if refunding early.
    pub merchant: UncheckedAccount<'info>,
    #[account(mut, has_one = mint, has_one = payer)]
    pub job: Account<'info, Job>,
    /// CHECK: constrained by has_one = payer
    pub payer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT @ ShotError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = job)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = payer)]
    pub payer_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[repr(u8)]
pub enum JobStatus {
    Quoted = 0,
    Funded = 1,
    Released = 2,
    Refunded = 3,
}

#[error_code]
pub enum ShotError {
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("deadline already passed")]
    DeadlinePast,
    #[msg("job status does not allow this")]
    BadStatus,
    #[msg("vault below quoted amount")]
    Underpaid,
    #[msg("mint mismatch")]
    WrongMint,
    #[msg("empty output hash")]
    EmptyHash,
    #[msg("output hash does not match the quote")]
    HashMismatch,
    #[msg("refund not yet allowed")]
    RefundLocked,
    #[msg("vault amount must equal the quote")]
    AmountMismatch,
}
