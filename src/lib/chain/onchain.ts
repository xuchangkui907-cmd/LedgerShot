/**
 * LedgerShot on-chain layout. Matches programs/ledger_shot/src/lib.rs v1.1.
 * Instruction data is Anchor-encoded (8-byte sha256 discriminator + borsh args).
 * No Anchor client: the IDL is not in this repo, so we build instructions by hand.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { PROGRAM_ID, USDC_MINT } from "./escrow.ts";

export const PROGRAM_PUBKEY = new PublicKey(PROGRAM_ID);
export const USDC_MINT_PUBKEY = new PublicKey(USDC_MINT);
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const JOB_SEED = "job";
export const JOB_ACCOUNT_SIZE = 234;
export const JOB_ACCOUNT_DISCRIMINATOR = hexToBytes("4b7c50cba1b4ca50");

/** First 8 bytes of sha256("global:<name>"). Locked by onchain.test.ts. */
export const DISCRIMINATOR = {
  init_job: hexToBytes("2dfb1f7a93a33422"),
  sync_funded: hexToBytes("b635d4faa129e5c1"),
  release: hexToBytes("fdf90fce1c7fc1f1"),
  refund: hexToBytes("0260b7fb3fd02e2e"),
} as const;

export const ANCHOR_ERROR: Record<number, { code: string; message: string }> = {
  6000: { code: "ZERO_AMOUNT", message: "Amount must be greater than 0." },
  6001: { code: "DEADLINE_PAST", message: "Deadline has already passed." },
  6002: { code: "BAD_STATUS", message: "Job status does not allow this instruction." },
  6003: { code: "UNDERPAID", message: "Vault is below the quoted amount." },
  6004: { code: "WRONG_MINT", message: "Mint does not match the job." },
  6005: { code: "EMPTY_HASH", message: "Hash must be 32 non-zero bytes." },
  6006: { code: "HASH_MISMATCH", message: "Output hash does not match the quote. Vault stays locked." },
  6007: { code: "REFUND_LOCKED", message: "Refund is locked until the merchant signs or the deadline passes." },
  6008: { code: "AMOUNT_MISMATCH", message: "Vault amount must equal the quoted USDC. Leftover tokens are rejected." },
};

export type OnchainStatus = "quoted" | "funded" | "released" | "refunded";

export type OnchainJob = {
  address: string;
  vault: string;
  payer: string;
  merchant: string;
  mint: string;
  amountAtomic: string;
  jobId: string;
  deadlineUnix: number;
  outputHash: string;
  specHash: string;
  expectedHash: string;
  status: OnchainStatus;
  statusRaw: number;
  bump: number;
};

export function hexToBytes(hex: string): Uint8Array {
  const text = hex.trim().toLowerCase().replace(/^0x/, "");
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new Error("Value is not hex");
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseJobId(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 16) throw new Error("Job id must be 16 bytes");
  return bytes;
}

export function parseHash32(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new Error("Hash must be 32 bytes");
  return bytes;
}

export function u64le(value: number | bigint): Uint8Array {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("u64 must be a non-negative safe integer");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

export function i64le(value: number | bigint): Uint8Array {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("i64 must be a safe integer");
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeInitJobData(input: {
  jobId: Uint8Array;
  amountAtomic: number;
  deadlineUnix: number;
  specHash: Uint8Array;
  expectedHash: Uint8Array;
}): Uint8Array {
  if (input.jobId.length !== 16) throw new Error("job_id must be 16 bytes");
  if (input.specHash.length !== 32 || input.expectedHash.length !== 32) {
    throw new Error("hashes must be 32 bytes");
  }
  return concatBytes(
    DISCRIMINATOR.init_job,
    input.jobId,
    u64le(input.amountAtomic),
    i64le(input.deadlineUnix),
    input.specHash,
    input.expectedHash,
  );
}

export function encodeReleaseData(outputHash: Uint8Array): Uint8Array {
  if (outputHash.length !== 32) throw new Error("output_hash must be 32 bytes");
  return concatBytes(DISCRIMINATOR.release, outputHash);
}

export function jobPda(payer: PublicKey, jobId: Uint8Array): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(JOB_SEED), payer.toBuffer(), jobId],
    PROGRAM_PUBKEY,
  );
  return { address, bump };
}

export function ataAddress(owner: PublicKey, mint: PublicKey = USDC_MINT_PUBKEY): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function vaultAddress(job: PublicKey): PublicKey {
  return ataAddress(job);
}

export function statusFromU8(value: number): OnchainStatus {
  if (value === 0) return "quoted";
  if (value === 1) return "funded";
  if (value === 2) return "released";
  if (value === 3) return "refunded";
  throw new Error(`Unknown job status ${value}`);
}

export function decodeJobAccount(data: Uint8Array, address: PublicKey): OnchainJob {
  if (data.length !== JOB_ACCOUNT_SIZE) {
    throw new Error(`Job account is ${data.length} bytes, expected exactly ${JOB_ACCOUNT_SIZE}`);
  }

  if (!JOB_ACCOUNT_DISCRIMINATOR.every((byte, index) => data[index] === byte)) {
    throw new Error("Invalid Anchor Job account discriminator");
  }

  let offset = 8;

  const readBytes = (length: number): Uint8Array => {
    if (!Number.isInteger(length) || length < 0 || offset + length > data.length) {
      throw new Error("Job account data is truncated");
    }
    const result = Uint8Array.from(data.subarray(offset, offset + length));
    offset += length;
    return result;
  };

  const readKey = () => new PublicKey(readBytes(32));
  const readU64 = () => new DataView(readBytes(8).buffer).getBigUint64(0, true);
  const readI64 = () => new DataView(readBytes(8).buffer).getBigInt64(0, true);

  const payer = readKey();
  const merchant = readKey();
  const mint = readKey();
  const amount = readU64();
  const jobIdBytes = readBytes(16);
  const jobId = bytesToHex(jobIdBytes);
  const deadlineBigInt = readI64();
  const outputHash = bytesToHex(readBytes(32));
  const specHash = bytesToHex(readBytes(32));
  const expectedHash = bytesToHex(readBytes(32));
  const statusRaw = readBytes(1)[0]!;
  const bump = readBytes(1)[0]!;

  if (offset !== JOB_ACCOUNT_SIZE) {
    throw new Error("Job account layout does not match the expected schema");
  }

  if (amount === 0n) {
    throw new Error("Job amount must be greater than zero");
  }

  if (
    deadlineBigInt < BigInt(Number.MIN_SAFE_INTEGER) ||
    deadlineBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Job deadline exceeds JavaScript safe integer range");
  }

  if (!mint.equals(USDC_MINT_PUBKEY)) {
    throw new Error("Job account contains an unexpected token mint");
  }

  const derived = jobPda(payer, jobIdBytes);
  if (!derived.address.equals(address)) {
    throw new Error("Job account address does not match its payer and job ID PDA");
  }
  if (derived.bump !== bump) {
    throw new Error("Job account bump does not match the derived PDA bump");
  }

  return {
    address: address.toBase58(),
    vault: vaultAddress(address).toBase58(),
    payer: payer.toBase58(),
    merchant: merchant.toBase58(),
    mint: mint.toBase58(),
    amountAtomic: amount.toString(),
    jobId,
    deadlineUnix: Number(deadlineBigInt),
    outputHash,
    specHash,
    expectedHash,
    status: statusFromU8(statusRaw),
    statusRaw,
    bump,
  };
}

function ix(programId: PublicKey, keys: AccountMeta[], data: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(data),
  });
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

export function buildInitJobIx(input: {
  merchant: PublicKey;
  payer: PublicKey;
  jobId: Uint8Array;
  amountAtomic: number;
  deadlineUnix: number;
  specHash: Uint8Array;
  expectedHash: Uint8Array;
}): { ix: TransactionInstruction; job: PublicKey; vault: PublicKey } {
  const { address: job } = jobPda(input.payer, input.jobId);
  const vault = vaultAddress(job);
  return {
    job,
    vault,
    ix: ix(
      PROGRAM_PUBKEY,
      [
        meta(input.merchant, true, true),
        meta(input.payer, false, false),
        meta(USDC_MINT_PUBKEY, false, false),
        meta(job, false, true),
        meta(vault, false, true),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
        meta(SystemProgram.programId, false, false),
      ],
      encodeInitJobData(input),
    ),
  };
}

export function buildSyncFundedIx(input: {
  payer: PublicKey;
  job: PublicKey;
  vault: PublicKey;
}): TransactionInstruction {
  return ix(
    PROGRAM_PUBKEY,
    [
      meta(input.payer, true, false),
      meta(input.job, false, true),
      meta(USDC_MINT_PUBKEY, false, false),
      meta(input.vault, false, false),
    ],
    DISCRIMINATOR.sync_funded,
  );
}

export function buildReleaseIx(input: {
  merchant: PublicKey;
  job: PublicKey;
  vault: PublicKey;
  merchantAta: PublicKey;
  outputHash: Uint8Array;
}): TransactionInstruction {
  return ix(
    PROGRAM_PUBKEY,
    [
      meta(input.merchant, true, false),
      meta(input.job, false, true),
      meta(USDC_MINT_PUBKEY, false, false),
      meta(input.vault, false, true),
      meta(input.merchantAta, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    encodeReleaseData(input.outputHash),
  );
}

export function buildRefundIx(input: {
  merchant: PublicKey;
  merchantMustSign: boolean;
  payer: PublicKey;
  job: PublicKey;
  vault: PublicKey;
  payerAta: PublicKey;
}): TransactionInstruction {
  return ix(
    PROGRAM_PUBKEY,
    [
      meta(input.merchant, input.merchantMustSign, false),
      meta(input.job, false, true),
      meta(input.payer, false, false),
      meta(USDC_MINT_PUBKEY, false, false),
      meta(input.vault, false, true),
      meta(input.payerAta, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    DISCRIMINATOR.refund,
  );
}

export function buildTransferIx(input: {
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amountAtomic: number;
}): TransactionInstruction {
  return ix(
    TOKEN_PROGRAM_ID,
    [
      meta(input.source, false, true),
      meta(input.destination, false, true),
      meta(input.owner, true, false),
    ],
    concatBytes(new Uint8Array([3]), u64le(input.amountAtomic)),
  );
}

export function buildCreateAtaIdempotentIx(input: {
  payer: PublicKey;
  owner: PublicKey;
  mint?: PublicKey;
}): { ix: TransactionInstruction; ata: PublicKey } {
  const mint = input.mint ?? USDC_MINT_PUBKEY;
  const ata = ataAddress(input.owner, mint);
  return {
    ata,
    ix: ix(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      [
        meta(input.payer, true, true),
        meta(ata, false, true),
        meta(input.owner, false, false),
        meta(mint, false, false),
        meta(SystemProgram.programId, false, false),
        meta(TOKEN_PROGRAM_ID, false, false),
      ],
      new Uint8Array([1]),
    ),
  };
}

export function mapProgramError(logs: string[] | null | undefined, err: unknown): {
  code: string;
  message: string;
} {
  const blob = `${JSON.stringify(err)} ${(logs ?? []).join("\n")}`.toLowerCase();
  const hexMatch = blob.match(/custom program error:\s*0x([0-9a-f]+)/i);
  const decMatch = blob.match(/custom program error:\s*(\d+)/i);
  let codeNum: number | null = null;
  if (hexMatch?.[1]) codeNum = Number.parseInt(hexMatch[1], 16);
  else if (decMatch?.[1]) codeNum = Number.parseInt(decMatch[1], 10);
  if (codeNum != null && ANCHOR_ERROR[codeNum]) return ANCHOR_ERROR[codeNum];
  if (blob.includes("hashmismatch") || blob.includes("hash mismatch")) {
    return ANCHOR_ERROR[6006]!;
  }
  if (blob.includes("blockhash not found") || blob.includes("blockhashnotfound")) {
    return { code: "BLOCKHASH_EXPIRED", message: "Blockhash expired. Rebuild the transaction and send again." };
  }
  if (blob.includes("insufficient funds") || blob.includes("insufficientlamports")) {
    return { code: "INSUFFICIENT_SOL", message: "Wallet needs more SOL for fees and account rent." };
  }
  return {
    code: "CHAIN_TX_FAILED",
    message: "The transaction was confirmed as failed on chain. The failure was not recognized as a LedgerShot program error; inspect the transaction logs.",
  };
}

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}
