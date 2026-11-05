import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { explorerTx } from "./onchain.ts";

const pubkey = z.string().trim().min(32).max(44);
const jobId = z.string().trim().regex(/^[0-9a-f]{32}$/);

const inspectSchema = z.object({
  payer: pubkey,
  merchant: pubkey.optional(),
  jobId: jobId.optional(),
});

const recordSchema = z.object({
  signature: z.string().trim().min(32).max(128),
  instruction: z.enum(["init_job", "sync_funded", "release", "refund"]),
  chainJobId: z.string().trim().min(1).max(64),
  payer: pubkey,
  merchant: pubkey,
  amountAtomic: z.number().int().nonnegative(),
  outputHash: z.string().trim().max(64).optional(),
  errorCode: z.string().trim().max(64).optional(),
  logs: z.array(z.string()).optional(),
});

export type ChainTxRow = {
  id: string;
  chain_job_id: string;
  tx_signature: string;
  instruction: string;
  slot: number | null;
  confirm_time: string | null;
  status: string;
  payer: string;
  merchant: string;
  amount_atomic: number;
  amount_atomic_text: string;
  output_hash: string;
  error_code: string;
  logs: string;
  chain_ok: boolean;
  program_ok: boolean;
  mint_ok: boolean;
  amount_ok: boolean;
  accounts_ok: boolean;
  parsed_ix: string;
  verify_issues: string;
  created_at: string;
  explorer_url: string;
};

export const getChainHead = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { chainHead } = await import("./rpc.ts");
    const head = await chainHead();
    return { ok: true as const, ...head, rpc: "devnet" };
  } catch (error) {
    return {
      ok: false as const,
      slot: 0,
      blockhash: "",
      lastValidBlockHeight: 0,
      rpc: "devnet",
      message: error instanceof Error ? error.message : "RPC unreachable",
    };
  }
});

export const inspectOnchainJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => inspectSchema.parse(input))
  .handler(async ({ data: input }) => {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { inspectChain, tokenBalance, solBalance, chainHead } = await import("./rpc.ts");
    const { ataAddress } = await import("./onchain.ts");
    const payer = new PublicKey(input.payer);
    const merchant = new PublicKey(input.merchant ?? input.payer);
    if (input.jobId) {
      const snapshot = await inspectChain(payer, input.jobId);
      return { ok: true as const, snapshot };
    }
    const [payerUsdc, merchantUsdc, payerSol, merchantSol, head] = await Promise.all([
      tokenBalance(ataAddress(payer)),
      tokenBalance(ataAddress(merchant)),
      solBalance(payer),
      solBalance(merchant),
      chainHead(),
    ]);
    return {
      ok: true as const,
      snapshot: {
        slot: head.slot,
        job: null,
        jobAddress: "",
        vault: { address: "", exists: false, atomic: 0 },
        payerUsdc,
        merchantUsdc,
        payerSolLamports: payerSol,
        merchantSolLamports: merchantSol,
        drift: [],
      },
    };
  } catch (error) {
    return {
      ok: false as const,
      snapshot: null,
      message: error instanceof Error ? error.message : "Inspect failed",
    };
  }
});

export const confirmAndRecordTx = createServerFn({ method: "POST" })
  .validator((input: unknown) => recordSchema.parse(input))
  .handler(async ({ data: input }) => {
  const { fetchCompiledTx } = await import("./rpc.ts");
  const { mapProgramError } = await import("./onchain.ts");
  const { verifyLedgerShotTx, atomicText } = await import("./verify.ts");
  const { getSql } = await import("@/lib/db");

  let status = "missing";
  let slot: number | null = null;
  let logs: string[] = input.logs ?? [];
  let errorCode = input.errorCode ?? "";
  let verified = {
    chainOk: false,
    programOk: false,
    mintOk: false,
    amountOk: false,
    accountsOk: false,
    parsedIx: "",
    amountAtomic: atomicText(input.amountAtomic),
    issues: ["Transaction not fetched"] as string[],
  };

  try {
    const compiled = await fetchCompiledTx(input.signature);
    slot = compiled.slot;
    logs = compiled.logs.length ? compiled.logs : logs;
    if (compiled.missing) {
      status = "missing";
      errorCode = "TX_NOT_FOUND";
      verified.issues = ["RPC did not return the transaction. Not marked confirmed."];
    } else {
      verified = verifyLedgerShotTx(
        {
          instruction: input.instruction,
          jobId: input.chainJobId,
          payer: input.payer,
          merchant: input.merchant,
          amountAtomic: atomicText(input.amountAtomic),
          outputHash: input.outputHash,
        },
        compiled.ixs,
        { pre: compiled.pre, post: compiled.post },
        compiled.err,
      );
      if (compiled.err) {
        status = "failed";
        errorCode = mapProgramError(compiled.logs, compiled.err).code;
      } else if (verified.chainOk) {
        status = "confirmed";
        errorCode = "";
      } else {
        status = "unverified";
        errorCode = "VERIFY_FAILED";
      }
    }
  } catch {
    status = "missing";
    errorCode = "TX_NOT_FOUND";
  }

  const sql = await getSql();
  const id = globalThis.crypto.randomUUID();
  await sql.query(
    `insert into chain_tx (
        id, chain_job_id, tx_signature, instruction, slot, confirm_time, status,
        payer, merchant, amount_atomic, amount_atomic_text, output_hash, error_code, logs,
        chain_ok, program_ok, mint_ok, amount_ok, accounts_ok, parsed_ix, verify_issues
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      on conflict (tx_signature) do update set
        status = excluded.status,
        slot = excluded.slot,
        confirm_time = excluded.confirm_time,
        error_code = excluded.error_code,
        logs = excluded.logs,
        amount_atomic_text = excluded.amount_atomic_text,
        chain_ok = excluded.chain_ok,
        program_ok = excluded.program_ok,
        mint_ok = excluded.mint_ok,
        amount_ok = excluded.amount_ok,
        accounts_ok = excluded.accounts_ok,
        parsed_ix = excluded.parsed_ix,
        verify_issues = excluded.verify_issues`,
    [
      id,
      input.chainJobId,
      input.signature,
      input.instruction,
      slot,
      status === "missing" ? null : new Date().toISOString(),
      status,
      input.payer,
      input.merchant,
      input.amountAtomic,
      verified.amountAtomic,
      input.outputHash ?? "",
      errorCode,
      logs.slice(-24).join("\n"),
      verified.chainOk,
      verified.programOk,
      verified.mintOk,
      verified.amountOk,
      verified.accountsOk,
      verified.parsedIx,
      verified.issues.join(" | "),
    ],
  );

  return {
    ok: verified.chainOk,
    verified: verified.chainOk,
    status,
    slot,
    errorCode,
    issues: verified.issues,
    explorerUrl: explorerTx(input.signature),
  };
});

export const listChainTx = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql.query<Omit<ChainTxRow, "explorer_url">>(
      `select id, chain_job_id, tx_signature, instruction, slot, confirm_time, status,
              payer, merchant, amount_atomic, coalesce(amount_atomic_text, '') as amount_atomic_text,
              output_hash, error_code, logs,
              coalesce(chain_ok, false) as chain_ok,
              coalesce(program_ok, false) as program_ok,
              coalesce(mint_ok, false) as mint_ok,
              coalesce(amount_ok, false) as amount_ok,
              coalesce(accounts_ok, false) as accounts_ok,
              coalesce(parsed_ix, '') as parsed_ix,
              coalesce(verify_issues, '') as verify_issues,
              created_at
       from chain_tx
       order by created_at desc
       limit 40`,
    );
    return {
      ok: true as const,
      rows: rows.map((row) => ({
        ...row,
        explorer_url: explorerTx(row.tx_signature),
      })),
    };
  } catch {
    return { ok: true as const, rows: [] as ChainTxRow[] };
  }
});
