import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { explorerTx } from "./onchain.ts";
import { ensureChainTxSchema } from "./chain-schema.ts";

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
  amountAtomic: z.number().int().positive().safe(),
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
        vault: { address: "", exists: false, atomic: "0" },
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
  const { fetchCompiledTx, fetchJob } = await import("./rpc.ts");
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
  let trustedOutputHash: string | undefined;

  try {
    const compiled = await fetchCompiledTx(input.signature);
    slot = compiled.slot;
    logs = compiled.logs.length ? compiled.logs : logs;
    if (compiled.missing) {
      status = "missing";
      errorCode = "TX_NOT_FOUND";
      verified.issues = ["RPC did not return the transaction. Not marked confirmed."];
    } else {

      if (input.instruction === "release") {
        const { PublicKey } = await import("@solana/web3.js");
        const { USDC_MINT_PUBKEY } = await import("./onchain.ts");
        const chainJob = await fetchJob(
          new PublicKey(input.payer),
          input.chainJobId,
        );

        if (!chainJob) {
          throw new Error("Cannot independently verify release: on-chain Job account does not exist.");
        }

        if (
          chainJob.payer !== input.payer ||
          chainJob.merchant !== input.merchant ||
          chainJob.jobId !== input.chainJobId ||
          chainJob.mint !== USDC_MINT_PUBKEY.toBase58() ||
          BigInt(atomicText(chainJob.amountAtomic)) !== BigInt(atomicText(input.amountAtomic)) ||
          chainJob.status !== "released" ||
          chainJob.outputHash !== chainJob.expectedHash
        ) {
          throw new Error("On-chain Job identity, quote, status, or release hash does not match the transaction claim.");
        }

        trustedOutputHash = chainJob.expectedHash;
      }

      verified = verifyLedgerShotTx(
        {
          instruction: input.instruction,
          jobId: input.chainJobId,
          payer: input.payer,
          merchant: input.merchant,
          amountAtomic: atomicText(input.amountAtomic),
          outputHash: trustedOutputHash,
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
  } catch (error) {
    status = "unverified";
    errorCode = "CHAIN_VERIFICATION_UNAVAILABLE";
    verified.chainOk = false;
    verified.issues = [
      error instanceof Error
        ? error.message
        : "Independent chain verification could not be completed.",
    ];
  }

  const sql = await getSql();
  await ensureChainTxSchema(sql);
  const id = globalThis.crypto.randomUUID();
  try {
    const saved = await sql.query<{
      id: string;
      status: string;
      slot: number | null;
      error_code: string;
      chain_ok: boolean;
      verify_issues: string;
    }>(
      `insert into chain_tx (
        id, chain_job_id, tx_signature, instruction, slot, confirm_time, status,
        payer, merchant, amount_atomic, amount_atomic_text, output_hash, error_code, logs,
        chain_ok, program_ok, mint_ok, amount_ok, accounts_ok, parsed_ix, verify_issues
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      on conflict (tx_signature) do update set
        status = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.status else chain_tx.status end,
        slot = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.slot else chain_tx.slot end,
        confirm_time = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.confirm_time else chain_tx.confirm_time end,
        error_code = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.error_code else chain_tx.error_code end,
        logs = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.logs else chain_tx.logs end,
        amount_atomic_text = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.amount_atomic_text else chain_tx.amount_atomic_text end,
        chain_ok = chain_tx.chain_ok or excluded.chain_ok,
        program_ok = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.program_ok else chain_tx.program_ok end,
        mint_ok = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.mint_ok else chain_tx.mint_ok end,
        amount_ok = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.amount_ok else chain_tx.amount_ok end,
        accounts_ok = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.accounts_ok else chain_tx.accounts_ok end,
        parsed_ix = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.parsed_ix else chain_tx.parsed_ix end,
        verify_issues = case when excluded.chain_ok or not chain_tx.chain_ok then excluded.verify_issues else chain_tx.verify_issues end
      where chain_tx.chain_job_id = excluded.chain_job_id
        and chain_tx.instruction = excluded.instruction
        and chain_tx.payer = excluded.payer
        and chain_tx.merchant = excluded.merchant
        and chain_tx.amount_atomic = excluded.amount_atomic
        and chain_tx.output_hash = excluded.output_hash
      returning id, status, slot, error_code, chain_ok, verify_issues`,
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
        trustedOutputHash ?? input.outputHash ?? "",
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

    if (saved.length !== 1) {
      throw new Error(
        "Transaction signature already exists with a different business identity. Record was not overwritten.",
      );
    }

    const persisted = saved[0]!;
    return {
      ok: persisted.chain_ok,
      verified: persisted.chain_ok,
      status: persisted.status,
      slot: persisted.slot,
      errorCode: persisted.error_code,
      issues: persisted.verify_issues ? persisted.verify_issues.split(" | ") : [],
      explorerUrl: explorerTx(input.signature),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not store the audit row.";
    const explicit = status === "unverified" || status === "failed" || status === "missing";
    return {
      ok: false,
      verified: false,
      status: explicit ? status : "unavailable",
      slot,
      errorCode: errorCode || "AUDIT_LOG_UNAVAILABLE",
      issues: [
        ...verified.issues.filter((item) => item.length > 0),
        explicit ? message : `Audit log was not stored: ${message}`,
      ],
      explorerUrl: explorerTx(input.signature),
    };
  }
});

export const listChainTx = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await ensureChainTxSchema(sql);
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
  } catch (error) {
    return {
      ok: false as const,
      rows: [] as ChainTxRow[],
      message: error instanceof Error ? error.message : "Could not load transaction records.",
    };
  }
});
