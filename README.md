# LedgerShot

**USDC escrow for AI-generated commerce deliverables on Solana.**

LedgerShot explores payment-per-deliverable settlement for AI media studios, commerce teams, and autonomous agents.
## How It Works

1. Create a quote for an AI-generated deliverable.
2. Fund the associated USDC escrow.
3. Confirm payment.
4. Verify delivery and request settlement.
5. Refund failed or expired jobs.

Lifecycle: `Quoted -> Funded -> Released / Refunded`
## Solana Program

- Network: Solana Devnet
- Program ID: `2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx`
- USDC Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Explorer: https://explorer.solana.com/address/2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx?cluster=devnet

Anchor instructions: `init_job`, `sync_funded`, `release`, `refund`.
## Application

- `/` — Judge Desk for quote creation, funding, settlement, hash-mismatch and refund rehearsal.
- `/ops` — Operations console for merchant ledger, fee locking, idempotency, dead letters and reconciliation.

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
npm run build
```

## Documentation

- Deployment guide: `docs/DEPLOY.md`
- Operations runbook: `docs/OPS-RUNBOOK.md`
## Deployment Status and Limitations

This repository contains the v1.1 Anchor source code, including expected-output-hash validation in the release instruction.

**Important:** The currently deployed Solana Devnet program is still v1. The v1.1 source code has not yet been upgraded on Devnet. Therefore, the on-chain hash validation in v1.1 is not active on Devnet.

The browser Judge Desk is a local demonstration and rehearsal. It does not independently broadcast Solana transactions or prove that a real USDC payment occurred.

A production x402 integration must verify the actual Solana payment transaction on the server side before releasing a deliverable.

## Security Notice

This is a Devnet prototype, not a production payment system. Never commit wallet keypairs, private keys, signing secrets, or environment files. Production use requires independent payment verification, security review, and smart-contract auditing.
