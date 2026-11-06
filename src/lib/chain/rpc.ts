import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ataAddress,
  decodeJobAccount,
  jobPda,
  mapProgramError,
  parseJobId,
  PROGRAM_PUBKEY,
  TOKEN_PROGRAM_ID,
  USDC_MINT_PUBKEY,
  vaultAddress,
  type OnchainJob,
} from "./onchain.ts";
import type { CompiledInstruction, TokenBalanceRow } from "./verify.ts";

export const DEVNET_RPC = "https://api.devnet.solana.com";
const COMMITMENT = "confirmed" as const;

let shared: Connection | null = null;

export function getConnection(): Connection {
  shared ??= new Connection(DEVNET_RPC, {
    commitment: COMMITMENT,
    confirmTransactionInitialTimeout: 60_000,
  });
  return shared;
}

export type TokenSnapshot = {
  address: string;
  exists: boolean;
  atomic: string;
};

export type ChainSnapshot = {
  slot: number;
  job: OnchainJob | null;
  jobAddress: string;
  vault: TokenSnapshot;
  payerUsdc: TokenSnapshot;
  merchantUsdc: TokenSnapshot;
  payerSolLamports: number;
  merchantSolLamports: number;
  drift: string[];
};

export async function tokenBalance(address: PublicKey): Promise<TokenSnapshot> {
  const connection = getConnection();
  const addressText = address.toBase58();

  // Only an explicit null account response means the token account is absent.
  // RPC/network/provider errors must propagate and must never become zero balance.
  const account = await connection.getAccountInfo(address, COMMITMENT);
  if (!account) {
    return { address: addressText, exists: false, atomic: "0" };
  }

  if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`Token account ${addressText} is not owned by the SPL Token Program.`);
  }

  const info = await connection.getTokenAccountBalance(address, COMMITMENT);
  const atomic = info.value.amount;
  if (typeof atomic !== "string" || !/^\d+$/.test(atomic)) {
    throw new Error(`Token account ${addressText} returned an invalid atomic balance.`);
  }

  return {
    address: addressText,
    exists: true,
    atomic,
  };
}

export async function solBalance(address: PublicKey): Promise<number> {
  return getConnection().getBalance(address, COMMITMENT);
}

export async function fetchJob(payer: PublicKey, jobIdHex: string): Promise<OnchainJob | null> {
  const jobId = parseJobId(jobIdHex);
  const { address } = jobPda(payer, jobId);
  const info = await getConnection().getAccountInfo(address, COMMITMENT);
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_PUBKEY)) {
    throw new Error("Account exists but is not owned by LedgerShot");
  }
  return decodeJobAccount(Uint8Array.from(info.data), address);
}

export async function inspectChain(payer: PublicKey, jobIdHex: string): Promise<ChainSnapshot> {
  const jobId = parseJobId(jobIdHex);
  const { address: jobAddress } = jobPda(payer, jobId);
  const vault = vaultAddress(jobAddress);
  const connection = getConnection();
  const job = await fetchJob(payer, jobIdHex);
  const merchant = job ? new PublicKey(job.merchant) : payer;
  const [slot, vaultBal, payerUsdc, merchantUsdc, payerSol, merchantSol] = await Promise.all([
    connection.getSlot(COMMITMENT),
    tokenBalance(vault),
    tokenBalance(ataAddress(payer)),
    tokenBalance(ataAddress(merchant)),
    solBalance(payer),
    solBalance(merchant),
  ]);
  return {
    slot,
    job,
    jobAddress: jobAddress.toBase58(),
    vault: vaultBal,
    payerUsdc,
    merchantUsdc,
    payerSolLamports: payerSol,
    merchantSolLamports: merchantSol,
    drift: reconcile(job, vaultBal),
  };
}

export function reconcile(job: OnchainJob | null, vault: TokenSnapshot): string[] {
  if (!job) return [];

  const issues: string[] = [];
  if (job.mint !== USDC_MINT_PUBKEY.toBase58()) {
    issues.push("Job mint is not Circle USDC.");
  }

  if (!vault.exists) {
    issues.push("Job vault token account is missing.");
    return issues;
  }

  if (!/^\d+$/.test(vault.atomic)) {
    issues.push("Job vault returned an invalid atomic balance.");
    return issues;
  }

  if (job.status === "quoted" && vault.atomic !== "0") {
    issues.push("Quoted job already has vault tokens.");
  }
  if (job.status === "funded" && BigInt(vault.atomic) !== BigInt(job.amountAtomic)) {
    issues.push("Funded vault does not equal the quote.");
  }
  if ((job.status === "released" || job.status === "refunded") && vault.atomic !== "0") {
    issues.push("Settled vault is not empty.");
  }
  return issues;
}

export async function simulateUnsigned(tx: Transaction): Promise<{
  ok: boolean;
  logs: string[];
  units: number | null;
  code: string;
  message: string;
}> {
  const vtx = new VersionedTransaction(tx.compileMessage());
  const result = await getConnection().simulateTransaction(vtx, {
    sigVerify: false,
    commitment: COMMITMENT,
  });
  const logs = result.value.logs ?? [];
  if (result.value.err) {
    const mapped = mapProgramError(logs, result.value.err);
    return { ok: false, logs, units: result.value.unitsConsumed ?? null, ...mapped };
  }
  return {
    ok: true,
    logs,
    units: result.value.unitsConsumed ?? null,
    code: "SIMULATED",
    message: "Simulation succeeded.",
  };
}

export type SignatureStatusDecision = "confirmed" | "failed" | "unknown";

/**
 * Classifies the RPC signature-status response.
 * A processed-only or missing status is never treated as confirmed.
 */
export function classifySignatureStatus(
  status: {
    err: unknown;
    confirmationStatus?: string | null;
  } | null,
): SignatureStatusDecision {
  if (!status) return "unknown";
  if (status.err !== null && status.err !== undefined) return "failed";

  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  ) {
    return "confirmed";
  }

  return "unknown";
}

export async function confirmSignature(
  signature: string,
  strategy: { blockhash: string; lastValidBlockHeight: number },
): Promise<{
  ok: boolean;
  missing: boolean;
  slot: number | null;
  err: unknown;
  logs: string[];
  confirmationStatus: "confirmed" | "failed" | "unknown";
}> {
  const connection = getConnection();

  const readTransaction = async () => {
    try {
      return await connection.getTransaction(signature, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      return null;
    }
  };

  const confirmedResult = async (slot: number | null = null) => {
    const tx = await readTransaction();
    const txError = tx?.meta?.err ?? null;

    if (txError) {
      return {
        ok: false,
        missing: !tx,
        slot: tx?.slot ?? slot,
        err: txError,
        logs: tx?.meta?.logMessages ?? [],
        confirmationStatus: "failed" as const,
      };
    }

    return {
      ok: true,
      missing: !tx,
      slot: tx?.slot ?? slot,
      err: null,
      logs: tx?.meta?.logMessages ?? [],
      confirmationStatus: "confirmed" as const,
    };
  };

  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: strategy.blockhash,
        lastValidBlockHeight: strategy.lastValidBlockHeight,
      },
      COMMITMENT,
    );

    if (confirmation.value.err) {
      const tx = await readTransaction();
      return {
        ok: false,
        missing: !tx,
        slot: tx?.slot ?? confirmation.context.slot,
        err: confirmation.value.err,
        logs: tx?.meta?.logMessages ?? [],
        confirmationStatus: "failed",
      };
    }

    return confirmedResult(confirmation.context.slot);
  } catch (confirmationError) {
    // Confirmation RPC may time out after the transaction was submitted.
    // Query historical signature status before deciding whether it failed.
    try {
      const response = await connection.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: true },
      );
      const status = response.value[0] ?? null;

      const decision = classifySignatureStatus(status);

      if (status && decision === "failed") {
        const tx = await readTransaction();
        return {
          ok: false,
          missing: !tx,
          slot: tx?.slot ?? status.slot,
          err: status.err,
          logs: tx?.meta?.logMessages ?? [],
          confirmationStatus: "failed",
        };
      }

      if (decision === "confirmed" && status) {
        return confirmedResult(status.slot);
      }
    } catch {
      // A failed status query does not prove that the transaction failed.
    }

    return {
      ok: false,
      missing: true,
      slot: null,
      err: confirmationError,
      logs: [],
      confirmationStatus: "unknown",
    };
  }
}

export async function fetchCompiledTx(signature: string): Promise<{
  missing: boolean;
  slot: number | null;
  err: unknown;
  logs: string[];
  ixs: CompiledInstruction[];
  pre: TokenBalanceRow[];
  post: TokenBalanceRow[];
}> {
  const tx = await getConnection().getTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    return {
      missing: true,
      slot: null,
      err: "TX_NOT_FOUND",
      logs: [],
      ixs: [],
      pre: [],
      post: [],
    };
  }

  // A transaction without metadata cannot be independently verified.
  // In particular, init_job must not pass verification with missing evidence.
  if (!tx.meta) {
    throw new Error("TX_METADATA_UNAVAILABLE: RPC returned a transaction without execution metadata.");
  }

  type RawIx = {
    programIdIndex: number;
    accounts?: number[];
    accountKeyIndexes?: number[];
    data: Uint8Array | string;
  };

  const message = tx.transaction.message as unknown as {
    accountKeys?: Array<PublicKey | string>;
    staticAccountKeys?: PublicKey[];
    instructions?: RawIx[];
    compiledInstructions?: RawIx[];
  };

  const loaded = (
    tx.meta as unknown as {
      loadedAddresses?: {
        writable?: PublicKey[];
        readonly?: PublicKey[];
      };
    } | null
  )?.loadedAddresses;

  // Solana v0 account index order: static, loaded writable, loaded readonly.
  const staticKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
  const keys = [
    ...staticKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ].map((key) => typeof key === "string" ? key : key.toBase58());

  const rawIxs = message.instructions ?? message.compiledInstructions ?? [];

  const mapIx = (
    ix: RawIx,
    inner: boolean,
    parentIndex?: number,
  ): CompiledInstruction => {
    if (
      !Number.isInteger(ix.programIdIndex) ||
      ix.programIdIndex < 0 ||
      ix.programIdIndex >= keys.length
    ) {
      throw new Error("Transaction contains an invalid program account index.");
    }

    const indexes = ix.accounts ?? ix.accountKeyIndexes;
    if (!Array.isArray(indexes)) {
      throw new Error("Transaction instruction has no valid account index array.");
    }

    const accounts = indexes.map((index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= keys.length
      ) {
        throw new Error("Transaction contains an invalid instruction account index.");
      }
      return keys[index]!;
    });

    const data = typeof ix.data === "string"
      ? decodeIxData(ix.data)
      : ix.data instanceof Uint8Array
        ? Uint8Array.from(ix.data)
        : (() => {
            throw new Error("Transaction instruction data has an invalid type.");
          })();

    return {
      programId: keys[ix.programIdIndex]!,
      accounts,
      data,
      inner,
      ...(parentIndex === undefined ? {} : { parentIndex }),
    };
  };

  const ixs: CompiledInstruction[] = rawIxs.map((ix) => mapIx(ix, false));

  // CPI instructions are required to verify Token Program transfers in
  // release/refund transactions.
  const innerGroups = (
    tx.meta as unknown as {
      innerInstructions?: Array<{
        index: number;
        instructions: RawIx[];
      }>;
    } | null
  )?.innerInstructions ?? [];

  const seenParentIndexes = new Set<number>();

  for (const group of innerGroups) {
    if (
      !Number.isInteger(group.index) ||
      group.index < 0 ||
      group.index >= rawIxs.length ||
      !Array.isArray(group.instructions) ||
      seenParentIndexes.has(group.index)
    ) {
      throw new Error("Transaction contains an invalid or duplicate CPI parent instruction index.");
    }

    seenParentIndexes.add(group.index);

    for (const ix of group.instructions) {
      ixs.push(mapIx(ix, true, group.index));
    }
  }

  const mapBal = (
    rows: NonNullable<typeof tx.meta>["preTokenBalances"],
  ): TokenBalanceRow[] => {
    const seenAccountIndexes = new Set<number>();

    return (rows ?? []).map((row) => {
      if (
        !Number.isInteger(row.accountIndex) ||
        row.accountIndex < 0 ||
        row.accountIndex >= keys.length ||
        seenAccountIndexes.has(row.accountIndex)
      ) {
        throw new Error("Transaction contains an invalid or duplicate token balance account index.");
      }

      if (
        typeof row.mint !== "string" ||
        typeof row.uiTokenAmount?.amount !== "string" ||
        !/^\d+$/.test(row.uiTokenAmount.amount) ||
        (row.owner !== undefined && typeof row.owner !== "string")
      ) {
        throw new Error("Transaction contains malformed token balance data.");
      }

      seenAccountIndexes.add(row.accountIndex);

      return {
        account: keys[row.accountIndex]!,
        mint: row.mint,
        owner: row.owner ?? "",
        amount: row.uiTokenAmount.amount,
      };
    });
  };

  return {
    missing: false,
    slot: tx.slot,
    err: tx.meta?.err ?? null,
    logs: tx.meta?.logMessages ?? [],
    ixs,
    pre: mapBal(tx.meta?.preTokenBalances ?? []),
    post: mapBal(tx.meta?.postTokenBalances ?? []),
  };
}
function decodeIxData(data: string): Uint8Array {
  try {
    return Uint8Array.from(bs58.decode(data));
  } catch {
    throw new Error("Transaction contains malformed Base58 instruction data.");
  }
}

export async function chainHead(): Promise<{
  slot: number;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const connection = getConnection();
  const [slot, latest] = await Promise.all([
    connection.getSlot(COMMITMENT),
    connection.getLatestBlockhash(COMMITMENT),
  ]);
  return { slot, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
}

export function mintPubkey(): PublicKey {
  return USDC_MINT_PUBKEY;
}
