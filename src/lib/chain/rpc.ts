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
  atomic: number;
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
  try {
    const info = await connection.getTokenAccountBalance(address, COMMITMENT);
    return {
      address: address.toBase58(),
      exists: true,
      atomic: Number(info.value.amount),
    };
  } catch {
    return { address: address.toBase58(), exists: false, atomic: 0 };
  }
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
  if (job.mint !== USDC_MINT_PUBKEY.toBase58()) issues.push("Job mint is not Circle USDC.");
  if (job.status === "quoted" && vault.atomic !== 0) issues.push("Quoted job already has vault tokens.");
  if (job.status === "funded" && vault.atomic !== job.amountAtomic) {
    issues.push("Funded vault does not equal the quote.");
  }
  if ((job.status === "released" || job.status === "refunded") && vault.atomic !== 0) {
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

export async function confirmSignature(signature: string): Promise<{
  ok: boolean;
  missing: boolean;
  slot: number | null;
  err: unknown;
  logs: string[];
  confirmationStatus: string | null;
}> {
  const connection = getConnection();
  const latest = await connection.getLatestBlockhash(COMMITMENT);
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    COMMITMENT,
  );
  const tx = await connection.getTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return {
      ok: false,
      missing: true,
      slot: null,
      err: "TX_NOT_FOUND",
      logs: [],
      confirmationStatus: "missing",
    };
  }
  const err = tx.meta?.err ?? null;
  return {
    ok: !err,
    missing: false,
    slot: tx.slot,
    err,
    logs: tx.meta?.logMessages ?? [],
    confirmationStatus: err ? "failed" : "confirmed",
  };
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
    return { missing: true, slot: null, err: "TX_NOT_FOUND", logs: [], ixs: [], pre: [], post: [] };
  }
  const message = tx.transaction.message as {
    accountKeys?: Array<PublicKey | string>;
    staticAccountKeys?: PublicKey[];
    instructions?: Array<{ programIdIndex: number; accounts: number[]; data: Uint8Array | string }>;
    compiledInstructions?: Array<{
      programIdIndex: number;
      accountKeyIndexes: number[];
      data: Uint8Array;
    }>;
  };
  const keys = (message.accountKeys ?? message.staticAccountKeys ?? []).map((key) =>
    typeof key === "string" ? key : key.toBase58(),
  );
  const rawIxs = message.instructions ?? message.compiledInstructions ?? [];
  const ixs: CompiledInstruction[] = rawIxs.map((ix) => {
    const indexes = "accounts" in ix ? ix.accounts : ix.accountKeyIndexes;
    const data = typeof ix.data === "string" ? decodeIxData(ix.data) : Uint8Array.from(ix.data);
    return {
      programId: keys[ix.programIdIndex] ?? "",
      accounts: indexes.map((index) => keys[index] ?? ""),
      data,
    };
  });
  const mapBal = (rows: NonNullable<typeof tx.meta>["preTokenBalances"]): TokenBalanceRow[] =>
    (rows ?? []).map((row) => ({
      account: keys[row.accountIndex] ?? "",
      mint: row.mint,
      owner: row.owner ?? "",
      amount: row.uiTokenAmount.amount,
    }));
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
    return new Uint8Array();
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
