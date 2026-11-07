import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ataAddress,
  buildCreateAtaIdempotentIx,
  buildInitJobIx,
  buildRefundIx,
  buildReleaseIx,
  buildSyncFundedIx,
  buildTransferIx,
  explorerTx,
  jobPda,
  mapProgramError,
  parseHash32,
  parseJobId,
  vaultAddress,
} from "./onchain.ts";
import {
  chainHead,
  confirmSignature,
  inspectChain,
  simulateUnsigned,
  type ChainSnapshot,
} from "./rpc.ts";
import { sendWithWallet, walletPubkey } from "./wallet.ts";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics.ts";

export type LiveIx = "init_job" | "sync_funded" | "release" | "refund";

export type LiveResult = {
  ok: boolean;
  code: string;
  message: string;
  instruction: LiveIx;
  signature: string | null;
  explorerUrl: string | null;
  slot: number | null;
  logs: string[];
  snapshot: ChainSnapshot | null;
};

function fail(instruction: LiveIx, code: string, message: string): LiveResult {
  return {
    ok: false,
    code,
    message,
    instruction,
    signature: null,
    explorerUrl: null,
    slot: null,
    logs: [],
    snapshot: null,
  };
}

function rejectDrift(instruction: LiveIx, snapshot: ChainSnapshot): LiveResult | null {
  if (snapshot.drift.length === 0) return null;
  return {
    ...fail(instruction, "CHAIN_DRIFT", snapshot.drift.join(" ")),
    message: `Chain state is inconsistent: ${snapshot.drift.join(" ")}`,
  };
}

function requireWallet(need: PublicKey, role: string): { ok: true; signer: PublicKey } | LiveResult {
  const signer = walletPubkey();
  if (!signer) return fail("init_job", "WALLET_REQUIRED", "Connect Phantom to send a real transaction.");
  if (!signer.equals(need)) {
    return fail(
      "init_job",
      "WRONG_SIGNER",
      `Connect the ${role} wallet ${need.toBase58()}.`,
    );
  }
  return { ok: true, signer };
}

async function sendLive(instruction: LiveIx, tx: Transaction, inspect: { payer: PublicKey; jobId: string }): Promise<LiveResult> {
  recordDiagnostic("TX_PREPARE", "start", { instruction, jobId: inspect.jobId });
  const head = await chainHead();
  const signer = walletPubkey();
  if (!signer) {
    recordDiagnostic("TX_PREPARE", "failure", { reason: "Wallet not connected" });
    return fail(instruction, "WALLET_REQUIRED", "Connect Phantom to send a real transaction.");
  }
  tx.feePayer = signer;
  tx.recentBlockhash = head.blockhash;
  recordDiagnostic("TX_PREPARE", "success", {
    instruction, jobId: inspect.jobId, slot: head.slot,
    feePayer: signer.toBase58(), blockhash: head.blockhash,
    lastValidBlockHeight: head.lastValidBlockHeight,
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable,
      })),
      dataLength: ix.data.length,
    })),
  });

  const simulated = await simulateUnsigned(tx);
  if (!simulated.ok) {
    recordDiagnostic("SIMULATION_GATE", "failure", {
      code: simulated.code, message: simulated.message, logs: simulated.logs, units: simulated.units,
    });
    return {
      ok: false,
      code: simulated.code,
      message: simulated.message,
      instruction,
      signature: null,
      explorerUrl: null,
      slot: head.slot,
      logs: simulated.logs,
      snapshot: await inspectChain(inspect.payer, inspect.jobId).catch(() => null),
    };
  }

  recordDiagnostic("SIMULATION_GATE", "success", { code: simulated.code, units: simulated.units, logs: simulated.logs });
  let signature: string;
  try {
    signature = await sendWithWallet(tx);
  } catch (error) {
    recordDiagnosticError("WALLET_RESULT", error);
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    return fail(
      instruction,
      "WALLET_SEND_UNKNOWN",
      `Wallet did not return a transaction signature. Submission may be uncertain; check Phantom activity before retrying. ${detail}`,
    );
  }

  recordDiagnostic("RPC_BROADCAST_RESULT", "success", { signature });
  const explorerUrl = explorerTx(signature);
  let confirmed: Awaited<ReturnType<typeof confirmSignature>>;
  try {
    recordDiagnostic("RPC_CONFIRMATION", "start", { signature });
    confirmed = await confirmSignature(signature, {
      blockhash: head.blockhash,
      lastValidBlockHeight: head.lastValidBlockHeight,
    });
    recordDiagnostic("RPC_CONFIRMATION", confirmed.confirmationStatus === "unknown" ? "failure" : confirmed.ok ? "success" : "failure", {
      signature, status: confirmed.confirmationStatus, slot: confirmed.slot,
      err: confirmed.err, logs: confirmed.logs, missing: confirmed.missing,
    });
  } catch (error) {
    recordDiagnosticError("RPC_CONFIRMATION", error);
    // Never discard a signature after the wallet has returned it.
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    return {
      ok: false,
      code: "CONFIRMATION_UNKNOWN",
      message: `Transaction was submitted, but confirmation could not be determined. Do not resend blindly. ${detail}`,
      instruction,
      signature,
      explorerUrl,
      slot: null,
      logs: [],
      snapshot: await inspectChain(inspect.payer, inspect.jobId).catch(() => null),
    };
  }

  const snapshot = await inspectChain(inspect.payer, inspect.jobId).catch(() => null);

  if (confirmed.confirmationStatus === "unknown") {
    return {
      ok: false,
      code: "CONFIRMATION_UNKNOWN",
      message: "Transaction signature received, but RPC confirmation status is unknown. Do not resend blindly; check the explorer and server verification.",
      instruction,
      signature,
      explorerUrl,
      slot: confirmed.slot,
      logs: confirmed.logs,
      snapshot,
    };
  }

  if (!confirmed.ok) {
    const mapped = mapProgramError(confirmed.logs, confirmed.err);
    return {
      ok: false,
      code: mapped.code,
      message: mapped.message,
      instruction,
      signature,
      explorerUrl,
      slot: confirmed.slot,
      logs: confirmed.logs,
      snapshot,
    };
  }

  if (confirmed.missing) {
    return {
      ok: true,
      code: "CONFIRMED_METADATA_PENDING",
      message: "Transaction reached confirmed commitment, but RPC transaction details are temporarily unavailable. Independent server verification is still required.",
      instruction,
      signature,
      explorerUrl,
      slot: confirmed.slot,
      logs: confirmed.logs,
      snapshot,
    };
  }

  return {
    ok: true,
    code: "CONFIRMED",
    message: `Confirmed ${instruction} on devnet.`,
    instruction,
    signature,
    explorerUrl,
    slot: confirmed.slot,
    logs: confirmed.logs,
    snapshot,
  };
}

export async function liveInitJob(input: {
  merchant: string;
  payer: string;
  jobId: string;
  amountAtomic: number;
  specHash: string;
  expectedHash: string;
  deadlineUnix?: number;
}): Promise<LiveResult> {
  recordDiagnostic("INIT_JOB_INPUT", "start", {
    merchant: input.merchant, payer: input.payer, amountAtomic: input.amountAtomic,
    jobId: input.jobId, deadlineUnix: input.deadlineUnix,
  });
  const merchant = new PublicKey(input.merchant);
  const payer = new PublicKey(input.payer);
  const signer = requireWallet(merchant, "merchant");
  if (!("signer" in signer)) return { ...signer, instruction: "init_job" };
  const jobId = parseJobId(input.jobId);
  const deadlineUnix = input.deadlineUnix ?? Math.floor(Date.now() / 1000) + 60 * 60;
  const built = buildInitJobIx({
    merchant,
    payer,
    jobId,
    amountAtomic: input.amountAtomic,
    deadlineUnix,
    specHash: parseHash32(input.specHash),
    expectedHash: parseHash32(input.expectedHash),
  });
  const tx = new Transaction().add(built.ix);
  recordDiagnostic("INIT_JOB_BUILD", "success", {
    programId: built.ix.programId.toBase58(),
    jobId: input.jobId,
    accountCount: built.ix.keys.length,
    accounts: built.ix.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable,
    })),
    dataLength: built.ix.data.length,
  });
  return sendLive("init_job", tx, { payer, jobId: input.jobId });
}

export async function liveFund(input: {
  payer: string;
  jobId: string;
  amountAtomic: number;
}): Promise<LiveResult> {
  const payer = new PublicKey(input.payer);
  const signer = requireWallet(payer, "payer");
  if (!("signer" in signer)) return { ...signer, instruction: "sync_funded" };

  const snapshot = await inspectChain(payer, input.jobId);
  if (!snapshot.job) return fail("sync_funded", "NOT_FOUND", "Job PDA is not on chain. Run init_job first.");
  if (snapshot.job.status !== "quoted") {
    return fail("sync_funded", "BAD_STATUS", `On-chain status is ${snapshot.job.status}.`);
  }
  if (!Number.isSafeInteger(input.amountAtomic) || input.amountAtomic <= 0) {
    return fail("sync_funded", "INVALID_AMOUNT", "Funding amount must be a positive safe integer.");
  }
  if (BigInt(input.amountAtomic) !== BigInt(snapshot.job.amountAtomic)) {
    return fail("sync_funded", "AMOUNT_MISMATCH", "Funding amount does not match the on-chain quote.");
  }
  const drift = rejectDrift("sync_funded", snapshot);
  if (drift) return drift;

  if (!snapshot.payerUsdc.exists) {
    return fail("sync_funded", "NO_PAYER_ATA", "Payer has no USDC token account on this mint.");
  }
  if (BigInt(snapshot.payerUsdc.atomic) < BigInt(input.amountAtomic)) {
    return fail(
      "sync_funded",
      "INSUFFICIENT_USDC",
      `Payer USDC ATA holds ${snapshot.payerUsdc.atomic} atomic, need ${input.amountAtomic}.`,
    );
  }

  const job = new PublicKey(snapshot.job.address);
  const vault = new PublicKey(snapshot.vault.address);
  const source = new PublicKey(snapshot.payerUsdc.address);
  const tx = new Transaction().add(
    buildTransferIx({
      source,
      destination: vault,
      owner: payer,
      amountAtomic: input.amountAtomic,
    }),
    buildSyncFundedIx({ payer, job, vault }),
  );
  return sendLive("sync_funded", tx, { payer, jobId: input.jobId });
}

export async function liveRelease(input: {
  merchant: string;
  payer: string;
  jobId: string;
  outputHash: string;
}): Promise<LiveResult> {
  const merchant = new PublicKey(input.merchant);
  const payer = new PublicKey(input.payer);
  const signer = requireWallet(merchant, "merchant");
  if (!("signer" in signer)) return { ...signer, instruction: "release" };

  const snapshot = await inspectChain(payer, input.jobId);
  if (!snapshot.job) return fail("release", "NOT_FOUND", "Job PDA is not on chain.");
  if (snapshot.job.status !== "funded") {
    return fail("release", "BAD_STATUS", `On-chain status is ${snapshot.job.status}.`);
  }
  const drift = rejectDrift("release", snapshot);
  if (drift) return drift;
  if (!snapshot.vault.exists || BigInt(snapshot.vault.atomic) !== BigInt(snapshot.job.amountAtomic)) {
    return fail("release", "AMOUNT_MISMATCH", "Vault balance must exactly equal the on-chain quote before release.");
  }

  const job = new PublicKey(snapshot.job.address);
  const vault = new PublicKey(snapshot.vault.address);
  const createMerchantAta = buildCreateAtaIdempotentIx({ payer: merchant, owner: merchant });
  const tx = new Transaction().add(
    createMerchantAta.ix,
    buildReleaseIx({
      merchant,
      job,
      vault,
      merchantAta: createMerchantAta.ata,
      outputHash: parseHash32(input.outputHash),
    }),
  );
  const result = await sendLive("release", tx, { payer, jobId: input.jobId });
  if (result.ok && result.snapshot) {
    if (result.snapshot.vault.atomic !== "0") {
      return {
        ...result,
        ok: false,
        code: "VAULT_NOT_EMPTY",
        message: "Release confirmed but the vault still holds tokens.",
      };
    }
  }
  return result;
}

export async function liveRefund(input: {
  merchant: string;
  payer: string;
  jobId: string;
}): Promise<LiveResult> {
  const merchant = new PublicKey(input.merchant);
  const payer = new PublicKey(input.payer);
  const signer = walletPubkey();
  if (!signer) return fail("refund", "WALLET_REQUIRED", "Connect Phantom to send a real transaction.");

  const snapshot = await inspectChain(payer, input.jobId);
  if (!snapshot.job) return fail("refund", "NOT_FOUND", "Job PDA is not on chain.");

  const chainMerchant = new PublicKey(snapshot.job.merchant);
  if (!merchant.equals(chainMerchant)) {
    return fail("refund", "MERCHANT_MISMATCH", "Merchant address does not match the on-chain Job.");
  }

  if (snapshot.job.status !== "funded") {
    return fail("refund", "BAD_STATUS", `On-chain status is ${snapshot.job.status}.`);
  }
  const drift = rejectDrift("refund", snapshot);
  if (drift) return drift;
  if (!snapshot.vault.exists || BigInt(snapshot.vault.atomic) !== BigInt(snapshot.job.amountAtomic)) {
    return fail("refund", "AMOUNT_MISMATCH", "Vault balance must exactly equal the on-chain quote before refund.");
  }

  const now = Math.floor(Date.now() / 1000);
  const merchantMustSign = now < snapshot.job.deadlineUnix;
  if (merchantMustSign && !signer.equals(chainMerchant)) {
    return fail("refund", "REFUND_LOCKED", "Before the deadline, the merchant wallet must sign the refund.");
  }

  const job = new PublicKey(snapshot.job.address);
  const vault = new PublicKey(snapshot.vault.address);
  const createPayerAta = buildCreateAtaIdempotentIx({ payer: signer, owner: payer });
  const tx = new Transaction().add(
    createPayerAta.ix,
    buildRefundIx({
      merchant: chainMerchant,
      merchantMustSign,
      payer,
      job,
      vault,
      payerAta: createPayerAta.ata,
    }),
  );
  const result = await sendLive("refund", tx, { payer, jobId: input.jobId });
  if (result.ok && result.snapshot && result.snapshot.vault.atomic !== "0") {
    return {
      ...result,
      ok: false,
      code: "VAULT_NOT_EMPTY",
      message: "Refund confirmed but the vault still holds tokens.",
    };
  }
  return result;
}

export async function liveInspect(payer: string, jobId: string): Promise<ChainSnapshot> {
  return inspectChain(new PublicKey(payer), jobId);
}

export function liveAddresses(payer: string, jobId: string): { job: string; vault: string } {
  const payerKey = new PublicKey(payer);
  const { address } = jobPda(payerKey, parseJobId(jobId));
  return { job: address.toBase58(), vault: vaultAddress(address).toBase58() };
}

export { ataAddress };
