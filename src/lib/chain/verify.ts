/**
 * Independent verification of a confirmed Solana transaction.
 * The client may claim an instruction; this module re-parses RPC bytes and
 * checks program id, discriminator, mint, accounts, and amount.
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ataAddress,
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
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PROGRAM_ID, USDC_MINT } from "./escrow.ts";

export type LiveIx = "init_job" | "sync_funded" | "release" | "refund";

export type CompiledInstruction = {
  programId: string;
  accounts: string[];
  data: Uint8Array;
  inner?: boolean;
  parentIndex?: number;
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
  let amount: bigint;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) throw new Error("amount is not an unsigned integer");
    amount = BigInt(value);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("numeric amount must be a non-negative safe integer");
    }
    amount = BigInt(value);
  } else {
    amount = value;
  }
  if (amount < 0n) throw new Error("amount must not be negative");
  return amount.toString();
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
  if (data.length !== 104 || decodeProgramIx(data) !== "init_job") return null;
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
  if (data.length !== 40 || decodeProgramIx(data) !== "release") return null;
  return { outputHash: bytesToHex(Uint8Array.from(data.subarray(8, 40))) };
}

export function decodeSplTransferAmount(data: Uint8Array): string | null {
  if (data.length !== 9 || data[0] !== 3) return null;
  const copy = Uint8Array.from(data.subarray(1, 9));
  return new DataView(copy.buffer).getBigUint64(0, true).toString();
}

export function tokenDelta(
  pre: TokenBalanceRow[],
  post: TokenBalanceRow[],
  account: string,
  mint: string,
): bigint {
  const before = pre.filter((row) => row.account === account && row.mint === mint);
  const after = post.filter((row) => row.account === account && row.mint === mint);
  if (before.length > 1 || after.length > 1) {
    throw new Error(`Duplicate token balance rows for ${account}`);
  }
  return BigInt(after[0]?.amount ?? "0") - BigInt(before[0]?.amount ?? "0");
}

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const ASSOCIATED_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const TOKEN_ID = TOKEN_PROGRAM_ID.toBase58();
const MINT_ID = USDC_MINT_PUBKEY.toBase58();

function exactAccounts(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function validHash(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function balanceAmount(
  rows: TokenBalanceRow[],
  account: string,
  owner: string,
  allowMissing: boolean,
): bigint | null {
  const matches = rows.filter((row) => row.account === account);
  if (matches.length > 1) throw new Error(`Duplicate token balance for ${account}`);
  if (matches.length === 0) {
    if (allowMissing) return null;
    throw new Error(`Missing token balance for ${account}`);
  }
  const row = matches[0]!;
  if (row.mint !== MINT_ID || row.owner !== owner) {
    throw new Error(`Token balance mint/owner mismatch for ${account}`);
  }
  if (!/^\d+$/.test(row.amount)) {
    throw new Error(`Invalid token amount for ${account}`);
  }
  return BigInt(row.amount);
}

function hasValidAtaCreation(
  ixs: CompiledInstruction[],
  ata: string,
  owner: string,
): boolean {
  return ixs.some((ix) =>
    ix.programId === ASSOCIATED_PROGRAM_ID &&
    exactAccounts(ix.accounts, [
      ix.accounts[0] ?? "",
      ata,
      owner,
      MINT_ID,
      SYSTEM_PROGRAM_ID,
      TOKEN_ID,
    ]) &&
    ix.data.length === 1 &&
    ix.data[0] === 1
  );
}

function verifyTransferAndBalances(input: {
  claim: VerifyClaim;
  ixs: CompiledInstruction[];
  pre: TokenBalanceRow[];
  post: TokenBalanceRow[];
  job: string;
  vault: string;
  payerAta: string;
  merchantAta: string;
  amount: bigint;
  expectedParentIndex: number;
}): { ok: boolean; mintOk: boolean; issues: string[] } {
  const {
    claim, ixs, pre, post, job, vault, payerAta, merchantAta,
    amount, expectedParentIndex,
  } = input;
  const issues: string[] = [];
  const tokenIxs = ixs.filter((ix) => ix.programId === TOKEN_ID);

  if (tokenIxs.length !== 1) {
    issues.push("Transaction must contain exactly one SPL Token instruction.");
    return { ok: false, mintOk: false, issues };
  }

  const transfer = tokenIxs[0]!;
  const expectedInner = claim.instruction === "release" || claim.instruction === "refund";
  if (transfer.inner !== expectedInner) {
    issues.push(
      claim.instruction === "sync_funded"
        ? "sync_funded SPL transfer must be a top-level instruction."
        : `${claim.instruction} SPL transfer must be an inner CPI instruction.`,
    );
  }

  if (
    expectedInner &&
    transfer.parentIndex !== expectedParentIndex
  ) {
    issues.push(
      `${claim.instruction} SPL transfer CPI is not attached to the matching LedgerShot instruction.`,
    );
  }

  if (!expectedInner && transfer.parentIndex !== undefined) {
    issues.push("Top-level SPL transfer must not have a CPI parent index.");
  }

  const transferAmount = decodeSplTransferAmount(transfer.data);
  if (transferAmount === null || transfer.accounts.length !== 3) {
    issues.push("SPL instruction is not an exact legacy Transfer instruction.");
    return { ok: false, mintOk: false, issues };
  }
  if (BigInt(transferAmount) !== amount) {
    issues.push("SPL transfer amount does not equal the quoted amount.");
  }

  let source = "";
  let destination = "";
  let authority = "";
  let sourceOwner = "";
  let destinationOwner = "";

  if (claim.instruction === "sync_funded") {
    source = payerAta;
    destination = vault;
    authority = claim.payer;
    sourceOwner = claim.payer;
    destinationOwner = job;
  } else if (claim.instruction === "release") {
    source = vault;
    destination = merchantAta;
    authority = job;
    sourceOwner = job;
    destinationOwner = claim.merchant;
  } else {
    source = vault;
    destination = payerAta;
    authority = job;
    sourceOwner = job;
    destinationOwner = claim.payer;
  }

  if (!exactAccounts(transfer.accounts, [source, destination, authority])) {
    issues.push("SPL transfer source, destination, or authority does not match the expected accounts.");
  }

  try {
    const sourceBefore = balanceAmount(pre, source, sourceOwner, false);
    const sourceAfter = balanceAmount(post, source, sourceOwner, false);
    const destinationBefore = balanceAmount(
      pre,
      destination,
      destinationOwner,
      claim.instruction !== "sync_funded",
    );
    const destinationAfter = balanceAmount(post, destination, destinationOwner, false);

    if (
      destinationBefore === null &&
      !hasValidAtaCreation(ixs, destination, destinationOwner)
    ) {
      throw new Error("Recipient ATA is missing before transfer without a valid idempotent ATA creation.");
    }

    if (sourceBefore === null || sourceAfter === null) {
      throw new Error("Source token account is missing from pre/post transaction balances.");
    }
    if (destinationAfter === null) {
      throw new Error("Destination token account is missing from post-transaction balances.");
    }

    if (sourceAfter - sourceBefore !== -amount) {
      issues.push("Source token account balance delta does not equal the outgoing amount.");
    }
    if (destinationAfter - (destinationBefore ?? 0n) !== amount) {
      issues.push("Destination token account balance delta does not equal the incoming amount.");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Token balance verification failed.");
  }

  return {
    ok: issues.length === 0,
    mintOk: true,
    issues,
  };
}

export function verifyLedgerShotTx(
  claim: VerifyClaim,
  ixs: CompiledInstruction[],
  token: { pre: TokenBalanceRow[]; post: TokenBalanceRow[] },
  txErr: unknown,
): VerifyResult {
  const issues: string[] = [];
  let claimedAmount = "0";
  let amountAtomic = "0";
  let programOk = false;
  let mintOk = false;
  let amountOk = false;
  let accountsOk = false;

  try {
    claimedAmount = atomicText(claim.amountAtomic);
    amountAtomic = claimedAmount;

    const payer = new PublicKey(claim.payer);
    const merchant = new PublicKey(claim.merchant);
    const jobId = parseJobId(claim.jobId);
    const { address: jobAddress } = jobPda(payer, jobId);
    const job = jobAddress.toBase58();
    const vault = vaultAddress(jobAddress).toBase58();
    const payerAta = ataAddress(payer).toBase58();
    const merchantAta = ataAddress(merchant).toBase58();

    // The LedgerShot instruction must be a top-level instruction.
    // CPI instructions are appended after all top-level instructions by the RPC mapper.
    const allProgramIxs = ixs.filter(
      (ix) => ix.programId === PROGRAM_ID,
    );
    const programIxs = allProgramIxs.filter((ix) => ix.inner !== true);
    const recognized = programIxs
      .map((ix) => ({ ix, name: decodeProgramIx(ix.data) }))
      .filter((item) => item.name !== null);

    const target = recognized.length === 1 ? recognized[0]! : null;

    programOk =
      allProgramIxs.length === 1 &&
      programIxs.length === 1 &&
      recognized.length === 1 &&
      target?.name === claim.instruction;

    if (!programOk) {
      issues.push("Transaction must contain exactly one LedgerShot instruction matching the claim.");
    }

    if (target) {
      const ix = target.ix;
      const amount = BigInt(claimedAmount);

      if (claim.instruction === "init_job") {
        const args = decodeInitJobArgs(ix.data);
        const expectedAccounts = [
          claim.merchant,
          claim.payer,
          MINT_ID,
          job,
          vault,
          TOKEN_ID,
          ASSOCIATED_PROGRAM_ID,
          SYSTEM_PROGRAM_ID,
        ];

        accountsOk = exactAccounts(ix.accounts, expectedAccounts);
        mintOk = ix.accounts[2] === MINT_ID;

        if (!accountsOk) issues.push("init_job account order or account count is invalid.");
        if (!mintOk) issues.push("init_job does not use the configured USDC mint.");
        if (!args) {
          accountsOk = false;
          issues.push("init_job instruction data has an invalid length or discriminator.");
        } else {
          if (args.jobId !== claim.jobId) {
            accountsOk = false;
            issues.push("Job id in init_job does not match the claim.");
          }
          amountAtomic = args.amountAtomic;
          amountOk = args.amountAtomic === claimedAmount && amount > 0n;
          if (!amountOk) issues.push("init_job amount does not match the claim or is zero.");
          if (args.specHash === "0".repeat(64) || args.expectedHash === "0".repeat(64)) {
            accountsOk = false;
            issues.push("init_job contains a zero spec hash or expected hash.");
          }
        }
      } else {
        let expectedProgramAccounts: string[];

        if (claim.instruction === "sync_funded") {
          expectedProgramAccounts = [claim.payer, job, MINT_ID, vault];
        } else if (claim.instruction === "release") {
          expectedProgramAccounts = [
            claim.merchant,
            job,
            MINT_ID,
            vault,
            merchantAta,
            TOKEN_ID,
          ];
        } else {
          expectedProgramAccounts = [
            claim.merchant,
            job,
            claim.payer,
            MINT_ID,
            vault,
            payerAta,
            TOKEN_ID,
          ];
        }

        accountsOk = exactAccounts(ix.accounts, expectedProgramAccounts);
        mintOk = ix.accounts[claim.instruction === "refund" ? 3 : 2] === MINT_ID;

        if (!accountsOk) {
          issues.push(`${claim.instruction} account order or account count is invalid.`);
        }
        if (!mintOk) issues.push(`${claim.instruction} does not use the configured USDC mint.`);

        if (claim.instruction === "release") {
          const args = decodeReleaseArgs(ix.data);
          if (!args) {
            accountsOk = false;
            issues.push("release instruction data is malformed.");
          } else if (!validHash(claim.outputHash) || args.outputHash !== claim.outputHash.toLowerCase()) {
            accountsOk = false;
            issues.push("Release output hash does not match the expected hash supplied by the verifier.");
          }
        } else if (ix.data.length !== 8) {
          accountsOk = false;
          issues.push(`${claim.instruction} instruction data must contain only its discriminator.`);
        }

        const targetIndex = ixs.indexOf(ix);
        if (targetIndex < 0) {
          throw new Error("LedgerShot instruction index could not be resolved.");
        }

        const transferResult = verifyTransferAndBalances({
          claim,
          ixs,
          pre: token.pre,
          post: token.post,
          job,
          vault,
          payerAta,
          merchantAta,
          amount,
          expectedParentIndex: targetIndex,
        });

        issues.push(...transferResult.issues);
        mintOk = mintOk && transferResult.mintOk;
        amountOk = transferResult.ok && BigInt(
          decodeSplTransferAmount(
            ixs.find((item) => item.programId === TOKEN_ID)?.data ?? new Uint8Array(),
          ) ?? "0",
        ) === amount;
        if (!amountOk) issues.push("Token transfer and balance changes do not prove the quoted amount.");
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Transaction verification failed.");
  }

  if (txErr != null) issues.push("On-chain execution returned an error.");

  const chainOk =
    txErr == null &&
    programOk &&
    mintOk &&
    amountOk &&
    accountsOk &&
    issues.length === 0;

  const parsedIx = (() => {
    const found = ixs
      .filter((ix) => ix.programId === PROGRAM_ID)
      .map((ix) => decodeProgramIx(ix.data))
      .find((name) => name !== null);
    return found ?? "unknown";
  })();

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
