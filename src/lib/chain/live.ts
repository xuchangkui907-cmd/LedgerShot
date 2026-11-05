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
  const head = await chainHead();
  const signer = walletPubkey();
  if (!signer) return fail(instruction, "WALLET_REQUIRED", "Connect Phantom to send a real transaction.");
  tx.feePayer = signer;
  tx.recentBlockhash = head.blockhash;

  const simulated = await simulateUnsigned(tx);
  if (!simulated.ok) {
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

  let signature: string;
  try {
    signature = await sendWithWallet(tx);
  } catch (error) {
    const mapped = mapProgramError([], error);
    return fail(instruction, mapped.code, mapped.message);
  }

  const confirmed = await confirmSignature(signature);
  const snapshot = await inspectChain(inspect.payer, inspect.jobId).catch(() => null);
  if (!confirmed.ok) {
    const mapped = mapProgramError(confirmed.logs, confirmed.err);
    return {
      ok: false,
      code: mapped.code,
      message: mapped.message,
      instruction,
      signature,
      explorerUrl: explorerTx(signature),
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
    explorerUrl: explorerTx(signature),
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
  if (snapshot.payerUsdc.atomic < input.amountAtomic) {
    return fail(
      "sync_funded",
      "INSUFFICIENT_USDC",
      `Payer USDC ATA holds ${snapshot.payerUsdc.atomic} atomic, need ${input.amountAtomic}.`,
    );
  }

  const job = new PublicKey(snapshot.job.address);
  const vault = new PublicKey(snapshot.vault.address);
  const source = new PublicKey(snapshot.payerUsdc.address);
  const tx = new Transaction();
  if (!snapshot.payerUsdc.exists) {
    return fail("sync_funded", "NO_PAYER_ATA", "Payer has no USDC token account on this mint.");
  }
  tx.add(
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
  if (snapshot.vault.atomic < snapshot.job.amountAtomic) {
    return fail("release", "UNDERPAID", "Vault token account is below the quoted amount.");
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
    if (result.snapshot.vault.atomic !== 0) {
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
  if (snapshot.job.status !== "funded") {
    return fail("refund", "BAD_STATUS", `On-chain status is ${snapshot.job.status}.`);
  }

  const now = Math.floor(Date.now() / 1000);
  const merchantMustSign = now < snapshot.job.deadlineUnix;
  if (merchantMustSign && !signer.equals(merchant)) {
    return fail("refund", "REFUND_LOCKED", "Before the deadline, the merchant wallet must sign the refund.");
  }

  const job = new PublicKey(snapshot.job.address);
  const vault = new PublicKey(snapshot.vault.address);
  const createPayerAta = buildCreateAtaIdempotentIx({ payer: signer, owner: payer });
  const tx = new Transaction().add(
    createPayerAta.ix,
    buildRefundIx({
      merchant,
      payer,
      job,
      vault,
      payerAta: createPayerAta.ata,
    }),
  );
  const result = await sendLive("refund", tx, { payer, jobId: input.jobId });
  if (result.ok && result.snapshot && result.snapshot.vault.atomic !== 0) {
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
