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

async function sendLive(
  instruction: LiveIx,
  tx: Transaction,
  inspect: { payer: PublicKey; jobId: string },
): Promise<LiveResult> {
  const traceId = `send-${Date.now()}`;

  const log = (stage: string, detail?: unknown) => {
    console.info("[LedgerShot][SendLive]", {
      traceId,
      time: new Date().toISOString(),
      instruction,
      stage,
      detail,
    });
  };

  const readSnapshot = async (stage: string) => {
    log(`${stage}.start`, {
      payer: inspect.payer.toBase58(),
      jobId: inspect.jobId,
    });

    try {
      const snapshot = await inspectChain(inspect.payer, inspect.jobId);
      log(`${stage}.success`, snapshot);
      return snapshot;
    } catch (error) {
      log(`${stage}.exception`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      });
      return null;
    }
  };

  log("send.start", {
    payer: inspect.payer.toBase58(),
    jobId: inspect.jobId,
    instructionCount: tx.instructions.length,
  });

  // 1. 获取 RPC 最新区块信息
  let head: Awaited<ReturnType<typeof chainHead>>;
  try {
    log("rpc.chain-head.start");
    head = await chainHead();
    log("rpc.chain-head.success", {
      slot: head.slot,
      blockhash: head.blockhash,
      lastValidBlockHeight: head.lastValidBlockHeight,
    });
  } catch (error) {
    log("rpc.chain-head.exception", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  }

  // 2. 检查钱包并准备交易
  const signer = walletPubkey();
  log("wallet.public-key", {
    signer: signer?.toBase58() ?? null,
    expectedPayer: inspect.payer.toBase58(),
    matchesPayer: signer?.equals(inspect.payer) ?? false,
  });

  if (!signer) {
    log("wallet.required.rejected");
    return fail(
      instruction,
      "WALLET_REQUIRED",
      "Connect Phantom to send a real transaction.",
    );
  }

  tx.feePayer = signer;
  tx.recentBlockhash = head.blockhash;

  log("transaction.prepared", {
    feePayer: tx.feePayer.toBase58(),
    recentBlockhash: tx.recentBlockhash,
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix, index) => ({
      index,
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((key) => ({
        address: key.pubkey.toBase58(),
        signer: key.isSigner,
        writable: key.isWritable,
      })),
      dataHex: Array.from(ix.data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    })),
  });

  // 3. RPC 模拟
  let simulated: Awaited<ReturnType<typeof simulateUnsigned>>;
  try {
    log("rpc.simulation.start");
    simulated = await simulateUnsigned(tx);

    log("rpc.simulation.result", {
      ok: simulated.ok,
      code: simulated.code,
      message: simulated.message,
      logs: simulated.logs,
      units: simulated.units,
    });
  } catch (error) {
    log("rpc.simulation.exception", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  }

  if (!simulated.ok) {
    log("rpc.simulation.rejected", {
      code: simulated.code,
      message: simulated.message,
    });

    const snapshot = await readSnapshot("chain.snapshot.after-simulation-failure");

    return {
      ok: false,
      code: simulated.code,
      message: simulated.message,
      instruction,
      signature: null,
      explorerUrl: null,
      slot: head.slot,
      logs: simulated.logs,
      snapshot,
    };
  }

  log("rpc.simulation.passed");

  // 4. 请求 Phantom 签名并发送
  let signature: string;
  try {
    log("wallet.send.start");
    signature = await sendWithWallet(tx);

    log("wallet.send.signature-received", {
      signature,
      explorerUrl: explorerTx(signature),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error.";

    log("wallet.send.exception", {
      name: error instanceof Error ? error.name : typeof error,
      message: detail,
      stack: error instanceof Error ? error.stack : null,
    });

    return fail(
      instruction,
      "WALLET_SEND_UNKNOWN",
      `Wallet did not return a transaction signature. Submission may be uncertain; check Phantom activity before retrying. ${detail}`,
    );
  }

  const explorerUrl = explorerTx(signature);

  // 5. 等待链上确认
  let confirmed: Awaited<ReturnType<typeof confirmSignature>>;
  try {
    log("rpc.confirm.start", {
      signature,
      blockhash: head.blockhash,
      lastValidBlockHeight: head.lastValidBlockHeight,
    });

    confirmed = await confirmSignature(signature, {
      blockhash: head.blockhash,
      lastValidBlockHeight: head.lastValidBlockHeight,
    });

    log("rpc.confirm.result", {
      ok: confirmed.ok,
      confirmationStatus: confirmed.confirmationStatus,
      missing: confirmed.missing,
      slot: confirmed.slot,
      err: confirmed.err ?? null,
      logs: confirmed.logs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown RPC error.";

    log("rpc.confirm.exception", {
      signature,
      message: detail,
      stack: error instanceof Error ? error.stack : null,
    });

    const snapshot = await readSnapshot("chain.snapshot.after-confirm-exception");

    return {
      ok: false,
      code: "CONFIRMATION_UNKNOWN",
      message: `Transaction was submitted, but confirmation could not be determined. Do not resend blindly. ${detail}`,
      instruction,
      signature,
      explorerUrl,
      slot: null,
      logs: [],
      snapshot,
    };
  }

  // 6. 无论确认结果如何，都复查链上状态
  const snapshot = await readSnapshot("chain.snapshot.after-confirm");

  // 7. 分类处理确认结果
  if (confirmed.confirmationStatus === "unknown") {
    log("transaction.confirmation-unknown", { signature });

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

    log("transaction.confirmation-failed", {
      signature,
      mappedCode: mapped.code,
      mappedMessage: mapped.message,
      chainError: confirmed.err,
      logs: confirmed.logs,
    });

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
    log("transaction.confirmed-metadata-pending", {
      signature,
      slot: confirmed.slot,
    });

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

  log("transaction.confirmed", {
    signature,
    explorerUrl,
    slot: confirmed.slot,
    snapshot,
  });

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
  const traceId = `fund-${Date.now()}`;
  const log = (stage: string, detail?: unknown) => {
    console.info("[LedgerShot][Fund]", {
      traceId,
      time: new Date().toISOString(),
      stage,
      detail,
    });
  };

  log("fund.start", {
    payer: input.payer,
    jobId: input.jobId,
    amountAtomic: input.amountAtomic,
  });

  const payer = new PublicKey(input.payer);
  log("fund.payer.parsed", { payer: payer.toBase58() });
  log("fund.wallet-check.start", { payer: payer.toBase58() });
  const signer = requireWallet(payer, "payer");
  if (!("signer" in signer)) {
    log("fund.wallet-check.rejected", signer);
    return { ...signer, instruction: "sync_funded" };
  }
  log("fund.wallet-check.passed");

  log("fund.inspect-chain.start", { jobId: input.jobId });
  const snapshot = await inspectChain(payer, input.jobId);
  log("fund.inspect-chain.result", {
    job: snapshot.job ?? null,
    vault: snapshot.vault ?? null,
    payerUsdc: snapshot.payerUsdc ?? null,
    merchantUsdc: snapshot.merchantUsdc ?? null,
    drift: snapshot.drift ?? null,
  });
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
  log("fund.drift-check.start");
  const drift = rejectDrift("sync_funded", snapshot);
  if (drift) {
    log("fund.drift-check.rejected", drift);
    return drift;
  }
  log("fund.drift-check.passed");

  if (!snapshot.payerUsdc.exists) {
    return fail("sync_funded", "NO_PAYER_ATA", "Payer has no USDC token account on this mint.");
  }
  log("fund.usdc-balance-check", {
    tokenAccount: snapshot.payerUsdc.address,
    balanceAtomic: snapshot.payerUsdc.atomic,
    requiredAtomic: input.amountAtomic,
  });

  if (BigInt(snapshot.payerUsdc.atomic) < BigInt(input.amountAtomic)) {
    const failure = fail(
      "sync_funded",
      "INSUFFICIENT_USDC",
      `Payer USDC ATA holds ${snapshot.payerUsdc.atomic} atomic, need ${input.amountAtomic}.`,
    );
    log("fund.usdc-balance-check.rejected", failure);
    return failure;
  }

  log("fund.transaction-build.start");
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
  log("fund.transaction-build.complete", {
    instructionCount: tx.instructions.length,
    instructions: tx.instructions.map((ix, index) => ({
      index,
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((key) => ({
        address: key.pubkey.toBase58(),
        signer: key.isSigner,
        writable: key.isWritable,
      })),
      dataHex: Array.from(ix.data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    })),
  });

  log("fund.send-live.start");
  const result = await sendLive("sync_funded", tx, {
    payer,
    jobId: input.jobId,
  });

  log("fund.send-live.result", {
    ok: result.ok,
    code: result.code,
    message: result.message,
    signature: result.signature ?? null,
    explorerUrl: result.explorerUrl ?? null,
    slot: result.slot ?? null,
    logs: result.logs ?? null,
    snapshot: result.snapshot ?? null,
  });

  return result;
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
