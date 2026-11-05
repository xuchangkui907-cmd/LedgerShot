/**
 * Independent verification of a confirmed Solana transaction.
 * The client may claim an instruction; this module re-parses RPC bytes and
 * checks program id, discriminator, mint, accounts, and amount.
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATOR,
  PROGRAM_PUBKEY,
  TOKEN_PROGRAM_ID,
  USDC_MINT_PUBKEY,
  bytesToHex,
  hexToBytes,
  jobPda,
  parseJobId,
  vaultAddress,
} from "./onchain.ts";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, USDC_MINT } from "./escrow.ts";

export type LiveIx = "init_job" | "sync_funded" | "release" | "refund";

export type CompiledInstruction = {
  programId: string;
  accounts: string[];
  data: Uint8Array;
};

export type TokenBalanceRow = {
  account: string;
  mint: string;
  owner: string;
  amount: string;
};

export type VerifyClaim = {
  instruction: LiveIx;
  jobId: string;
  payer: string;
  merchant: string;
  amountAtomic: string;
  outputHash?: string;
};

export type VerifyResult = {
  chainOk: boolean;
  programOk: boolean;
  mintOk: boolean;
  amountOk: boolean;
  accountsOk: boolean;
  parsedIx: string;
  amountAtomic: string;
  issues: string[];
};

const DISC_NAME: Record<string, LiveIx> = {
  [bytesToHex(DISCRIMINATOR.init_job)]: "init_job",
  [bytesToHex(DISCRIMINATOR.sync_funded)]: "sync_funded",
  [bytesToHex(DISCRIMINATOR.release)]: "release",
  [bytesToHex(DISCRIMINATOR.refund)]: "refund",
};

export function atomicText(value: number | string | bigint): string {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) throw new Error("amount is not an unsigned integer");
    return value;
  }
  return BigInt(value).toString();
}

export function decodeProgramIx(data: Uint8Array): LiveIx | null {
  if (data.length < 8) return null;
  return DISC_NAME[bytesToHex(data.subarray(0, 8))] ?? null;
}

export function decodeInitJobArgs(data: Uint8Array): {
  jobId: string;
  amountAtomic: string;
  deadlineUnix: string;
  specHash: string;
  expectedHash: string;
} | null {
  if (data.length < 104) return null;
  if (decodeProgramIx(data) !== "init_job") return null;
  let offset = 8;
  const take = (n: number) => {
    const slice = data.subarray(offset, offset + n);
    offset += n;
    return Uint8Array.from(slice);
  };
  const jobId = bytesToHex(take(16));
  const amountAtomic = new DataView(take(8).buffer).getBigUint64(0, true).toString();
  const deadlineUnix = new DataView(take(8).buffer).getBigInt64(0, true).toString();
  return {
    jobId,
    amountAtomic,
    deadlineUnix,
    specHash: bytesToHex(take(32)),
    expectedHash: bytesToHex(take(32)),
  };
}

export function decodeReleaseArgs(data: Uint8Array): { outputHash: string } | null {
  if (data.length < 40) return null;
  if (decodeProgramIx(data) !== "release") return null;
  return { outputHash: bytesToHex(Uint8Array.from(data.subarray(8, 40))) };
}

export function decodeSplTransferAmount(data: Uint8Array): string | null {
  if (data.length < 9 || data[0] !== 3) return null;
  const copy = Uint8Array.from(data.subarray(1, 9));
  return new DataView(copy.buffer).getBigUint64(0, true).toString();
}

export function tokenDelta(
  pre: TokenBalanceRow[],
  post: TokenBalanceRow[],
  account: string,
  mint: string,
): bigint {
  const before = pre.find((row) => row.account === account && row.mint === mint);
  const after = post.find((row) => row.account === account && row.mint === mint);
  return BigInt(after?.amount ?? "0") - BigInt(before?.amount ?? "0");
}

export function verifyLedgerShotTx(
  claim: VerifyClaim,
  ixs: CompiledInstruction[],
  token: { pre: TokenBalanceRow[]; post: TokenBalanceRow[] },
  txErr: unknown,
): VerifyResult {
  const issues: string[] = [];
  const claimedAmount = atomicText(claim.amountAtomic);
  const programIxs = ixs.filter((ix) => ix.programId === PROGRAM_ID);
  const parsedNames = programIxs.map((ix) => decodeProgramIx(ix.data)).filter((name): name is LiveIx => Boolean(name));
  const parsedIx = parsedNames.includes(claim.instruction)
    ? claim.instruction
    : (parsedNames[0] ?? "unknown");

  const programOk = programIxs.length > 0 && parsedNames.includes(claim.instruction);
  if (!programOk) issues.push("Transaction does not contain the claimed LedgerShot instruction.");

  const mintTouched = [...token.pre, ...token.post].some((row) => row.mint === USDC_MINT);
  const mintInAccounts = ixs.some((ix) => ix.accounts.includes(USDC_MINT));
  const mintOk = claim.instruction === "init_job" ? mintInAccounts : mintInAccounts || mintTouched;
  if (!mintOk) issues.push("Circle USDC mint is not in the transaction.");

  let accountsOk = true;
  let amountOk = true;
  let amountAtomic = claimedAmount;

  try {
    const payer = new PublicKey(claim.payer);
    const jobId = parseJobId(claim.jobId);
    const { address: job } = jobPda(payer, jobId);
    const vault = vaultAddress(job);

    const target = programIxs.find((ix) => decodeProgramIx(ix.data) === claim.instruction);
    if (target) {
      if (claim.instruction === "init_job") {
        const args = decodeInitJobArgs(target.data);
        if (!args) {
          accountsOk = false;
          issues.push("init_job data could not be decoded.");
        } else {
          if (args.jobId !== claim.jobId) {
            accountsOk = false;
            issues.push("Job id in the instruction does not match the claim.");
          }
          amountAtomic = args.amountAtomic;
          if (args.amountAtomic !== claimedAmount) {
            amountOk = false;
            issues.push("Quoted amount in the instruction does not match the claim.");
          }
        }
        if (!target.accounts.includes(claim.payer) || !target.accounts.includes(claim.merchant)) {
          accountsOk = false;
          issues.push("Payer or merchant is missing from init_job accounts.");
        }
        if (!target.accounts.includes(USDC_MINT) || !target.accounts.includes(job.toBase58())) {
          accountsOk = false;
          issues.push("Mint or job PDA is missing from init_job accounts.");
        }
      }

      if (claim.instruction === "sync_funded") {
        const transfers = ixs.filter((ix) => ix.programId === TOKEN_PROGRAM_ID.toBase58());
        const moved = transfers
          .map((ix) => decodeSplTransferAmount(ix.data))
          .filter((value): value is string => value != null);
        const transferHit = moved.includes(claimedAmount);
        const vaultDelta = tokenDelta(token.pre, token.post, vault.toBase58(), USDC_MINT);
        amountAtomic = vaultDelta !== 0n ? vaultDelta.toString() : claimedAmount;
        if (!transferHit && vaultDelta !== BigInt(claimedAmount)) {
          amountOk = false;
          issues.push("Vault USDC delta does not equal the quoted amount.");
        }
        if (!target.accounts.includes(claim.payer) || !target.accounts.includes(job.toBase58())) {
          accountsOk = false;
          issues.push("sync_funded accounts do not match payer/job PDA.");
        }
      }

      if (claim.instruction === "release") {
        const args = decodeReleaseArgs(target.data);
        if (claim.outputHash && args && args.outputHash !== claim.outputHash) {
          accountsOk = false;
          issues.push("Release output hash does not match the claim.");
        }
        const vaultDelta = tokenDelta(token.pre, token.post, vault.toBase58(), USDC_MINT);
        if (txErr == null && vaultDelta !== -BigInt(claimedAmount)) {
          amountOk = false;
          issues.push("Release did not drain the quoted amount from the vault.");
        }
        if (!target.accounts.includes(claim.merchant) || !target.accounts.includes(job.toBase58())) {
          accountsOk = false;
          issues.push("release accounts do not match merchant/job PDA.");
        }
      }

      if (claim.instruction === "refund") {
        const vaultDelta = tokenDelta(token.pre, token.post, vault.toBase58(), USDC_MINT);
        if (txErr == null && vaultDelta !== -BigInt(claimedAmount)) {
          amountOk = false;
          issues.push("Refund did not return the quoted amount from the vault.");
        }
        if (!target.accounts.includes(job.toBase58()) || !target.accounts.includes(claim.payer)) {
          accountsOk = false;
          issues.push("refund accounts do not match payer/job PDA.");
        }
      }
    }
  } catch (error) {
    accountsOk = false;
    issues.push(error instanceof Error ? error.message : "Account check failed.");
  }

  if (txErr != null) {
    issues.push("On-chain execution returned an error.");
  }

  const chainOk = txErr == null && programOk && mintOk && amountOk && accountsOk && issues.length === 0;
  return {
    chainOk,
    programOk,
    mintOk,
    amountOk,
    accountsOk,
    parsedIx,
    amountAtomic,
    issues,
  };
}

export function idlLock(): { address: string; mint: string; discriminators: Record<string, string> } {
  return {
    address: PROGRAM_ID,
    mint: USDC_MINT,
    discriminators: {
      init_job: bytesToHex(DISCRIMINATOR.init_job),
      sync_funded: bytesToHex(DISCRIMINATOR.sync_funded),
      release: bytesToHex(DISCRIMINATOR.release),
      refund: bytesToHex(DISCRIMINATOR.refund),
    },
  };
}

export function expectedProgram(): string {
  return PROGRAM_PUBKEY.toBase58();
}

export function expectedMint(): string {
  return USDC_MINT_PUBKEY.toBase58();
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, hexToBytes };
