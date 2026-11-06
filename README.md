# LedgerShot

**On-chain USDC escrow and settlement infrastructure for AI-generated commerce deliverables.**

LedgerShot connects AI media studios, commerce teams, clients, and autonomous agents through a verifiable payment workflow on Solana. Funds are held in program-controlled escrow and released only when the delivered asset satisfies the conditions committed to the job.

## How It Works

1. Create a job quote with the deliverable specification, USDC amount, deadline, and expected output hash.
2. Transfer the agreed USDC amount into the job-specific on-chain escrow vault.
3. Verify the funding transaction and escrow balance on Solana.
4. Validate the delivered asset against the expected SHA-256 hash and submit settlement.
5. Refund eligible jobs according to the on-chain authorization and deadline rules.

Lifecycle: `Quoted -> Funded -> Released / Refunded`

## Solana Program

- Network: Solana Devnet
- Program ID: `2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx`
- USDC Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Explorer: https://explorer.solana.com/address/2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx?cluster=devnet

Anchor instructions: `init_job`, `sync_funded`, `release`, `refund`.

## Application

- `/` — Settlement workspace for job quotes, escrow funding, wallet-signed Devnet transactions, deliverable verification, settlement, and refunds. Supports both local rehearsal and live Devnet modes.
- `/ops` — Rehearsal operations console for simulated merchant ledgers, fee accounting, idempotent processing, failure handling, chain transaction inspection, and ledger reconciliation.

## Technology Stack

- TypeScript
- React 19
- TanStack Start
- Rust
- Anchor 0.31.1
- Solana Devnet

## Run Locally

Requirements: Node.js 22 and npm.

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Run checks:

```bash
npm test
npm run typecheck
npm run lint
```

Build the application without running database migrations:

```bash
node scripts/with-app-env.mjs vite build
```

## Documentation

- Deployment guide: `docs/DEPLOY.md`
- Operations runbook: `docs/OPS-RUNBOOK.md`

## Deployment Status

The Anchor program has been upgraded and deployed on Solana Devnet. The deployed release instruction enforces the expected deliverable hash committed to each job.

The deployed program also validates the configured USDC mint, escrow funding amount, job authority, and settlement conditions. Transactions are submitted through the connected wallet and verified against Solana Devnet.

The application provides a local rehearsal mode and a live Devnet mode. Live mode uses wallet authorization to submit transactions; server-side chain inspection verifies transaction results and on-chain job state.

A production x402 integration must verify the actual Solana payment transaction on the server side before releasing a deliverable.

## Security Notice

This is a Devnet prototype, not a production payment system. Never commit wallet keypairs, private keys, signing secrets, or environment files. Production use requires independent payment verification, security review, and smart-contract auditing.
