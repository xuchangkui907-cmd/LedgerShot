# LedgerShot Deployment Guide

This guide documents the deployed Solana Devnet program, application configuration, deployment verification, and operational safeguards.

LedgerShot is an on-chain USDC escrow and settlement application for AI-generated commerce deliverables. Its Anchor program stores the job specification and expected deliverable hash on-chain, verifies escrow funding, and enforces hash and deadline conditions before releasing funds. The v1.2 program has been successfully upgraded on Solana Devnet.

## 0. On-chain Identity

| Field | Value |
| --- | --- |
| Cluster | Devnet |
| Program id | `2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx` |
| Upgrade Authority | `2ASr3Aa2mJZPsU5FFfwJvcoHhy8GT9gY4gZw4EYPX4oD` |
| USDC Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle Devnet USDC, 6 decimals) |
| Explorer | https://explorer.solana.com/address/2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx?cluster=devnet |

If a deployed page shows a different program ID, use the ID listed above. The program keypair corresponds to the program ID; it is **not** the upgrade authority. Never commit `ledger_shot-keypair.json` to the public repository or include it in documentation.

## 1. Toolchain

```bash
solana --version    # Use a compatible 2.x release
anchor --version    # Must be 0.31.1
rustc --version
node --version      # 22
```

```bash
# If Anchor 0.31.1 is not installed
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 0.31.1
avm use 0.31.1
```

```bash
solana config set --url devnet
solana address
```

The `solana address` output must be `2ASr3Aa2mJZPsU5FFfwJvcoHhy8GT9gY4gZw4EYPX4oD`. If it does not match, switch to the authorized upgrade wallet before proceeding. Using a different key may cause the upgrade to fail or create a separate deployment with a program ID that does not match the frontend.

```bash
solana balance
# Request an airdrop if the balance is below 2 SOL
solana airdrop 2
```

## 2. Program Upgrade Procedure

**Current status:** The v1.2 program is already deployed on Devnet. The commands below are for a future, intentional program upgrade only; they are not part of a routine application release. Do not execute them unless the new program binary has been reviewed, tested, backed up, and explicitly approved for deployment.

Before upgrading, verify the configured program ID and upgrade authority. Preserve the current deployed binary and IDL so the previous release can be inspected and recovered from where supported.

Run these commands from the repository root containing `Anchor.toml`:

```bash
anchor build
# declare_id! and target/deploy must retain this program ID
# 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx
anchor deploy --provider.cluster devnet --program-name ledger_shot
```

Before upgrading, verify `declare_id!`, `Anchor.toml`, the target program ID, and the upgrade wallet authority. Do not generate a new keypair or change the program ID as a substitute for upgrading the existing program.

Equivalent native Solana CLI command (use only if `anchor deploy` fails):

```bash
solana program deploy target/deploy/ledger_shot.so \
  --program-id 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx \
  --url devnet
```

Verify the deployment:

```bash
solana program show 2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx --url devnet
```

`Authority` should match the upgrade authority listed above, and `Last Deployed In Slot` should show the new deployment slot. Keep the updated `target/idl/ledger_shot.json` in the repository. Do not distribute the old v1 IDL as the current interface.

v1.2 instruction flow and account roles:

1. `init_job(job_id: [u8;16], amount: u64, deadline_unix: i64, spec_hash: [u8;32], expected_hash: [u8;32])`
   - The merchant signs and pays the account rent.
   - The payer is included in the PDA seeds but does not sign this instruction.
   - The token mint is Devnet USDC.
   - job PDA seeds = `["job", payer, job_id]`
   - The vault is the job associated token account (ATA).
2. In the same transaction or a subsequent transaction, transfer exactly `amount` from the payer ATA to the vault using SPL Token Transfer, then call `sync_funded` (the payer signs; `has_one = payer`).
3. The merchant signs `release(output_hash)`. `output_hash` must equal `expected_hash`, and the deadline must not have passed.
4. The merchant may sign `refund` before the deadline; after the deadline, anyone may call it.

`spec_hash` commits to the job specification. `expected_hash` is the SHA-256 hash of the exact deliverable bytes. The on-chain release instruction checks the submitted output hash against the value stored in the job account and enforces the deadline.

## 3. Application

The application provides a settlement workspace at `/` and an operations console at `/ops`. The workspace supports local rehearsal and live Solana Devnet mode. In live mode, users authorize transactions with their connected wallet; the application verifies transaction results and on-chain job state. The rehearsal mode is separate and does not represent an on-chain transaction.

Local development:

```bash
npm install
npm test
npm run typecheck
node scripts/with-app-env.mjs vite build
npm run dev
```

The application uses TanStack Start. Build with `node scripts/with-app-env.mjs vite build`; this command builds the application and does not run database migrations. Keep production environment files and signing keys out of the repository and browser bundle. Never expose the program upgrade authority to the client.

The application is deployed at https://ledgershot.verbodesk.com/. Application releases and Solana program upgrades are separate operations. Updating the web application does not require redeploying the on-chain program.

## 4. Deployment Verification

1. Confirm the program ID, Devnet cluster, executable status, and upgrade authority using Solana Explorer or `solana program show`.
2. Open https://ledgershot.verbodesk.com/ and confirm the settlement workspace loads.
3. Verify local rehearsal mode separately from live Devnet mode. A rehearsal result is not evidence of an on-chain transaction.
4. In live mode, connect a supported wallet and verify transaction signatures and resulting job state on Solana Devnet.
5. Open `/ops` and inspect the available ledger, transaction, and reconciliation information.

## 5. Security and Operational Notes

- This deployment uses Solana Devnet and Devnet USDC. It is not a mainnet payment service.
- Never commit wallet keypairs, private keys, seed phrases, signing secrets, or environment files.
- Keep the program upgrade authority in a secure operator-controlled environment. Never expose it to browser code.
- Review and test program changes before upgrading the deployed program. Verify the program ID and upgrade authority before every upgrade.
- Do not treat client-side state or rehearsal output as proof of payment. Verify transaction signatures and on-chain account state.
- Production use requires an independent security review, smart-contract audit, and production-grade payment verification.
