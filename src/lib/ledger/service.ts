import {
  fingerprintOf,
  idempotencyKeyOf,
  parseCommand,
  type Command,
} from "./contract.ts";
import { MAX_ATTEMPTS, classify, failureHint, retryDelayMs } from "./failure.ts";

export type { Command };

/** Prepaid merchant book. Every amount is integer micro-USDC. */

export type MerchantStatus = "active" | "frozen" | "settlement_hold";
export type RiskTier = "low" | "medium" | "high";
export type Sku = "still" | "dub" | "short";
export type JobState =
  | "quoted"
  | "reserved"
  | "dispatched"
  | "settled"
  | "refunded"
  | "dead_letter"
  | "written_off";

export type Merchant = {
  id: string;
  name: string;
  desk: string;
  pool: string;
  region: string;
  wallet: string;
  status: MerchantStatus;
  resumeStatus: "active" | "settlement_hold";
  risk: RiskTier;
  feeBps: number;
  creditMicro: number;
  reservedMicro: number;
  platformRevenueMicro: number;
  supplierPayableMicro: number;
  platformLossMicro: number;
  openingMicro: number;
};

export type Job = {
  id: string;
  merchantId: string;
  sku: Sku;
  title: string;
  state: JobState;
  quoteMicro: number;
  feeBpsLocked: number;
  feeMicro: number;
  supplierMicro: number;
  attempts: number;
  traceId: string;
  lastError: string;
  failureClass: string;
  nextRetryAt: number;
  createdAt: number;
  updatedAt: number;
  settledAt: number;
  lastWebhook: {
    outcome: "render.completed" | "render.failed";
    errorCode: string;
    idempotencyKey: string;
  } | null;
};

export type LedgerEvent = {
  id: string;
  ts: number;
  traceId: string;
  jobId: string;
  merchantId: string;
  kind: "transition" | "reject" | "audit" | "incident";
  code: string;
  message: string;
  from: string;
  to: string;
};

export type Incident = {
  id: string;
  severity: "sev2" | "sev3";
  title: string;
  status: "open" | "mitigated" | "closed";
  openedAt: number;
  summary: string;
};

export type IdemRecord = {
  fingerprint: string;
  ok: boolean;
  code: string;
  message: string;
  jobId: string;
};

export type World = {
  merchants: Merchant[];
  jobs: Job[];
  events: LedgerEvent[];
  incidents: Incident[];
  idempotency: Record<string, IdemRecord>;
  seq: number;
};

export type ApplyResult = {
  world: World;
  ok: boolean;
  code: string;
  message: string;
  replay: boolean;
  jobId?: string;
};

export const HOLDING_STATES: JobState[] = ["reserved", "dispatched", "dead_letter"];

const SKU_LABEL: Record<Sku, string> = {
  still: "静帧",
  dub: "配音",
  short: "短剧",
};

export function skuLabel(sku: Sku): string {
  return SKU_LABEL[sku];
}

export function emptyWorld(): World {
  return { merchants: [], jobs: [], events: [], incidents: [], idempotency: {}, seq: 0 };
}

export function feeOf(quoteMicro: number, feeBps: number): number {
  return Math.floor((quoteMicro * feeBps) / 10_000);
}

export function applyParsed(world: World, input: unknown, now: number): ApplyResult {
  const parsed = parseCommand(input);
  if (!parsed.ok) {
    return reject(world, now, "CONTRACT_VIOLATION", parsed.issues.join("；"), "", "", "");
  }
  return apply(world, parsed.command, now);
}

export function apply(world: World, command: Command, now: number): ApplyResult {
  if (command.type === "operator" && command.action === "replay") {
    const job = world.jobs.find((item) => item.id === command.jobId);
    if (!job?.lastWebhook) {
      return reject(world, now, "NO_WEBHOOK", "该任务没有可回放的回调", "", command.jobId ?? "", command.merchantId ?? "");
    }
    return apply(world, {
      type: "webhook",
      jobId: job.id,
      outcome: job.lastWebhook.outcome,
      errorCode: job.lastWebhook.errorCode || undefined,
      idempotencyKey: job.lastWebhook.idempotencyKey,
    }, now);
  }

  const key = idempotencyKeyOf(command);
  if (key) {
    const prev = world.idempotency[key];
    if (prev) {
      if (prev.fingerprint !== fingerprintOf(command)) {
        return reject(
          world,
          now,
          "IDEMPOTENCY_CONFLICT",
          "幂等键已绑定不同请求，拒绝执行",
          "",
          prev.jobId,
          "",
        );
      }
      return replay(world, prev, now);
    }
  }

  const result = applyFresh(world, command, now);
  if (!key || !result.ok) return result;
  const recorded = clone(result.world);
  recorded.idempotency[key] = {
    fingerprint: fingerprintOf(command),
    ok: true,
    code: result.code,
    message: result.message,
    jobId: result.jobId ?? "",
  };
  return { ...result, world: recorded };
}

function applyFresh(world: World, command: Command, now: number): ApplyResult {
  switch (command.type) {
    case "quote":
      return quote(world, command, now);
    case "reserve":
      return reserve(world, command, now);
    case "dispatch":
      return dispatch(world, command, now);
    case "complete":
      return settle(world, command.jobId, command.idempotencyKey, "render.completed", "", now);
    case "fail":
      return failJob(world, command.jobId, command.errorCode, command.idempotencyKey, now, true);
    case "webhook":
      if (command.outcome === "render.completed") {
        return settle(world, command.jobId, command.idempotencyKey, command.outcome, "", now);
      }
      return failJob(world, command.jobId, command.errorCode ?? "UPSTREAM_UNKNOWN", command.idempotencyKey, now, true);
    case "operator":
      return operate(world, command, now);
    case "tick":
      return tick(world, now);
    case "incident":
      return closeIncident(world, command, now);
  }
}

function quote(world: World, command: Extract<Command, { type: "quote" }>, now: number): ApplyResult {
  const merchant = world.merchants.find((item) => item.id === command.merchantId);
  if (!merchant) {
    return reject(world, now, "MERCHANT_NOT_FOUND", "商户不存在", "", "", command.merchantId);
  }
  const next = clone(world);
  next.seq += 1;
  const job: Job = {
    id: `job_${next.seq}`,
    merchantId: merchant.id,
    sku: command.sku,
    title: command.title,
    state: "quoted",
    quoteMicro: command.quoteMicro,
    feeBpsLocked: 0,
    feeMicro: 0,
    supplierMicro: 0,
    attempts: 0,
    traceId: `tr_${next.seq}`,
    lastError: "",
    failureClass: "",
    nextRetryAt: 0,
    createdAt: now,
    updatedAt: now,
    settledAt: 0,
    lastWebhook: null,
  };
  next.jobs.push(job);
  push(next, now, job, "transition", "QUOTED", `已报价 ${command.title}`, "", "quoted");
  return ok(next, "QUOTED", "报价已生成，尚未冻结预授权", job.id);
}

function reserve(world: World, command: Extract<Command, { type: "reserve" }>, now: number): ApplyResult {
  const job = world.jobs.find((item) => item.id === command.jobId);
  if (!job) return reject(world, now, "JOB_NOT_FOUND", "任务不存在", "", command.jobId, "");
  if (job.state !== "quoted") {
    return reject(world, now, "ILLEGAL_STATE", `当前状态 ${job.state} 不能冻结预授权`, job.traceId, job.id, job.merchantId);
  }
  const merchant = world.merchants.find((item) => item.id === job.merchantId);
  if (!merchant) return reject(world, now, "MERCHANT_NOT_FOUND", "商户不存在", job.traceId, job.id, job.merchantId);
  if (merchant.status === "frozen") {
    return reject(world, now, "MERCHANT_FROZEN", "商户已冻结，拒绝新的预授权", job.traceId, job.id, merchant.id);
  }
  if (merchant.creditMicro < job.quoteMicro) {
    return reject(world, now, "INSUFFICIENT_CREDIT", "可用预存不足，拒绝冻结", job.traceId, job.id, merchant.id);
  }
  const next = clone(world);
  const nextJob = mustJob(next, job.id);
  const nextMerchant = mustMerchant(next, merchant.id);
  nextMerchant.creditMicro -= nextJob.quoteMicro;
  nextMerchant.reservedMicro += nextJob.quoteMicro;
  nextJob.feeBpsLocked = nextMerchant.feeBps;
  nextJob.state = "reserved";
  nextJob.updatedAt = now;
  push(next, now, nextJob, "transition", "RESERVED", "预授权已冻结", "quoted", "reserved");
  return ok(next, "RESERVED", "预授权已冻结", nextJob.id);
}

function dispatch(world: World, command: Extract<Command, { type: "dispatch" }>, now: number): ApplyResult {
  const job = world.jobs.find((item) => item.id === command.jobId);
  if (!job) return reject(world, now, "JOB_NOT_FOUND", "任务不存在", "", command.jobId, "");
  if (job.state !== "reserved") {
    return reject(world, now, "ILLEGAL_STATE", `当前状态 ${job.state} 不能派发`, job.traceId, job.id, job.merchantId);
  }
  const next = clone(world);
  const nextJob = mustJob(next, job.id);
  nextJob.state = "dispatched";
  nextJob.updatedAt = now;
  push(next, now, nextJob, "transition", "DISPATCHED", "已派发到渲染池", "reserved", "dispatched");
  return ok(next, "DISPATCHED", "已派发", nextJob.id);
}

function settle(
  world: World,
  jobId: string,
  idempotencyKey: string,
  outcome: "render.completed" | "render.failed",
  errorCode: string,
  now: number,
): ApplyResult {
  const job = world.jobs.find((item) => item.id === jobId);
  if (!job) return reject(world, now, "JOB_NOT_FOUND", "任务不存在", "", jobId, "");
  if (job.state !== "dispatched") {
    return reject(world, now, "ILLEGAL_STATE", `当前状态 ${job.state} 不能结算`, job.traceId, job.id, job.merchantId);
  }
  const merchant = world.merchants.find((item) => item.id === job.merchantId);
  if (!merchant) return reject(world, now, "MERCHANT_NOT_FOUND", "商户不存在", job.traceId, job.id, job.merchantId);
  if (merchant.status === "frozen") {
    return reject(world, now, "MERCHANT_FROZEN", "商户已冻结，结算已挡住", job.traceId, job.id, merchant.id);
  }
  if (merchant.status === "settlement_hold") {
    return reject(world, now, "SETTLEMENT_HELD", "结算暂停中，预授权继续冻结", job.traceId, job.id, merchant.id);
  }
  const fee = feeOf(job.quoteMicro, job.feeBpsLocked);
  const supplier = job.quoteMicro - fee;
  const next = clone(world);
  const nextJob = mustJob(next, job.id);
  const nextMerchant = mustMerchant(next, merchant.id);
  nextMerchant.reservedMicro -= nextJob.quoteMicro;
  nextMerchant.platformRevenueMicro += fee;
  nextMerchant.supplierPayableMicro += supplier;
  nextJob.state = "settled";
  nextJob.feeMicro = fee;
  nextJob.supplierMicro = supplier;
  nextJob.updatedAt = now;
  nextJob.settledAt = now;
  nextJob.nextRetryAt = 0;
  nextJob.lastError = "";
  nextJob.lastWebhook = { outcome, errorCode, idempotencyKey };
  push(next, now, nextJob, "transition", "SETTLED", "结算完成，预授权已划转为收入与渲染池应付", "dispatched", "settled");
  return ok(next, "SETTLED", "结算完成", nextJob.id);
}

function failJob(
  world: World,
  jobId: string,
  errorCode: string,
  idempotencyKey: string,
  now: number,
  rememberWebhook: boolean,
): ApplyResult {
  const job = world.jobs.find((item) => item.id === jobId);
  if (!job) return reject(world, now, "JOB_NOT_FOUND", "任务不存在", "", jobId, "");
  if (job.state !== "reserved" && job.state !== "dispatched") {
    return reject(world, now, "ILLEGAL_STATE", `当前状态 ${job.state} 不能接收失败`, job.traceId, job.id, job.merchantId);
  }
  const failureClass = classify(errorCode);
  const next = clone(world);
  const nextJob = mustJob(next, job.id);
  const from = nextJob.state;
  nextJob.attempts += 1;
  nextJob.lastError = errorCode;
  nextJob.failureClass = failureClass;
  nextJob.updatedAt = now;
  if (rememberWebhook) {
    nextJob.lastWebhook = { outcome: "render.failed", errorCode, idempotencyKey };
  }
  if (nextJob.state === "reserved") nextJob.state = "dispatched";

  const permanent = failureClass === "permanent";
  const unknownExhausted = failureClass === "unknown" && nextJob.attempts >= 2;
  const transientExhausted = failureClass === "transient" && nextJob.attempts >= MAX_ATTEMPTS;
  if (permanent) {
    refundHeld(next, nextJob, now, from === "reserved" ? "reserved" : from, "永久失败，预授权已全额退回");
    return ok(next, "REFUNDED", failureHint(errorCode), nextJob.id);
  }
  if (unknownExhausted || transientExhausted) {
    nextJob.state = "dead_letter";
    nextJob.nextRetryAt = 0;
    push(next, now, nextJob, "transition", "DEAD_LETTER", failureHint(errorCode), from, "dead_letter");
    openDeadLetterIncident(next, nextJob, now);
    return ok(next, "DEAD_LETTER", "进入死信，预授权继续冻结", nextJob.id);
  }
  nextJob.state = "dispatched";
  nextJob.nextRetryAt = now + retryDelayMs(nextJob.attempts);
  push(next, now, nextJob, "transition", "RETRY_SCHEDULED", `暂时失败 ${errorCode}，第 ${nextJob.attempts} 次后进入退避`, from, "dispatched");
  return ok(next, "RETRY_SCHEDULED", `已安排第 ${nextJob.attempts} 次后的重试`, nextJob.id);
}

function operate(world: World, command: Extract<Command, { type: "operator" }>, now: number): ApplyResult {
  switch (command.action) {
    case "freeze":
    case "unfreeze":
    case "hold":
    case "release_hold":
      return operateMerchant(world, command, now);
    case "retry":
    case "refund":
    case "write_off":
      return operateJob(world, command, now);
    case "replay":
      return reject(world, now, "NO_WEBHOOK", "缺少可回放回调", "", command.jobId ?? "", command.merchantId ?? "");
  }
}

function operateMerchant(world: World, command: Extract<Command, { type: "operator" }>, now: number): ApplyResult {
  if (!command.merchantId) {
    return reject(world, now, "MERCHANT_REQUIRED", "商户管控需要 merchantId", "", "", "");
  }
  const merchant = world.merchants.find((item) => item.id === command.merchantId);
  if (!merchant) return reject(world, now, "MERCHANT_NOT_FOUND", "商户不存在", "", "", command.merchantId);
  const next = clone(world);
  const nextMerchant = mustMerchant(next, merchant.id);
  if (command.action === "freeze") {
    if (nextMerchant.status === "frozen") {
      return reject(world, now, "ILLEGAL_STATE", "商户已经处于冻结", "", "", merchant.id);
    }
    nextMerchant.resumeStatus = nextMerchant.status === "settlement_hold" ? "settlement_hold" : "active";
    nextMerchant.status = "frozen";
    pushMerchant(next, now, merchant.id, "MERCHANT_FROZEN", `${command.actor} 冻结商户：${command.reason}`);
    return ok(next, "MERCHANT_FROZEN", "商户已冻结，新预授权与结算都会被拒绝", undefined);
  }
  if (command.action === "unfreeze") {
    if (nextMerchant.status !== "frozen") {
      return reject(world, now, "ILLEGAL_STATE", "商户并未冻结", "", "", merchant.id);
    }
    nextMerchant.status = nextMerchant.resumeStatus;
    pushMerchant(next, now, merchant.id, "MERCHANT_UNFROZEN", `${command.actor} 解冻商户：${command.reason}`);
    return ok(next, "MERCHANT_UNFROZEN", "商户已恢复到冻结前状态", undefined);
  }
  if (command.action === "hold") {
    if (nextMerchant.status !== "active") {
      return reject(world, now, "ILLEGAL_STATE", "只有活跃商户可以暂停结算", "", "", merchant.id);
    }
    nextMerchant.status = "settlement_hold";
    nextMerchant.resumeStatus = "settlement_hold";
    pushMerchant(next, now, merchant.id, "SETTLEMENT_HELD", `${command.actor} 暂停结算：${command.reason}`);
    return ok(next, "SETTLEMENT_HELD", "结算已暂停，在途预授权保持冻结", undefined);
  }
  if (nextMerchant.status !== "settlement_hold") {
    return reject(world, now, "ILLEGAL_STATE", "结算并未暂停", "", "", merchant.id);
  }
  nextMerchant.status = "active";
  nextMerchant.resumeStatus = "active";
  pushMerchant(next, now, merchant.id, "SETTLEMENT_RELEASED", `${command.actor} 恢复结算：${command.reason}`);
  return ok(next, "SETTLEMENT_RELEASED", "结算已恢复", undefined);
}

function operateJob(world: World, command: Extract<Command, { type: "operator" }>, now: number): ApplyResult {
  if (!command.jobId) return reject(world, now, "JOB_REQUIRED", "任务动作需要 jobId", "", "", "");
  const job = world.jobs.find((item) => item.id === command.jobId);
  if (!job) return reject(world, now, "JOB_NOT_FOUND", "任务不存在", "", command.jobId, "");
  const merchant = world.merchants.find((item) => item.id === job.merchantId);
  if (!merchant) return reject(world, now, "MERCHANT_NOT_FOUND", "商户不存在", job.traceId, job.id, job.merchantId);

  if (command.action === "retry") {
    if (job.state !== "dead_letter") {
      return reject(world, now, "ILLEGAL_STATE", "只有死信可以人工重试", job.traceId, job.id, job.merchantId);
    }
    if (merchant.status === "frozen") {
      return reject(world, now, "MERCHANT_FROZEN", "商户已冻结，不能把死信重新派发", job.traceId, job.id, merchant.id);
    }
    const next = clone(world);
    const nextJob = mustJob(next, job.id);
    nextJob.state = "dispatched";
    nextJob.attempts = Math.max(0, MAX_ATTEMPTS - 1);
    nextJob.nextRetryAt = 0;
    nextJob.failureClass = "";
    nextJob.updatedAt = now;
    push(next, now, nextJob, "transition", "OPERATOR_RETRY", `${command.actor} 重试死信：${command.reason}`, "dead_letter", "dispatched");
    return ok(next, "OPERATOR_RETRY", "死信已重新派发，预授权仍然冻结", nextJob.id);
  }

  if (command.action === "refund") {
    if (!HOLDING_STATES.includes(job.state)) {
      return reject(world, now, "ILLEGAL_STATE", "该状态没有可退的预授权", job.traceId, job.id, job.merchantId);
    }
    const next = clone(world);
    const nextJob = mustJob(next, job.id);
    const from = nextJob.state;
    refundHeld(next, nextJob, now, from, `${command.actor} 人工退款：${command.reason}`);
    return ok(next, "REFUNDED", "预授权已退回商户可用余额", nextJob.id);
  }

  if (job.state !== "dead_letter") {
    return reject(world, now, "ILLEGAL_STATE", "只有死信可以核销", job.traceId, job.id, job.merchantId);
  }
  const next = clone(world);
  const nextJob = mustJob(next, job.id);
  const nextMerchant = mustMerchant(next, merchant.id);
  nextMerchant.reservedMicro -= nextJob.quoteMicro;
  nextMerchant.platformLossMicro += nextJob.quoteMicro;
  nextJob.state = "written_off";
  nextJob.updatedAt = now;
  nextJob.nextRetryAt = 0;
  push(next, now, nextJob, "transition", "WRITTEN_OFF", `${command.actor} 核销死信：${command.reason}`, "dead_letter", "written_off");
  return ok(next, "WRITTEN_OFF", "预授权转为平台损耗，不再退回商户", nextJob.id);
}

function tick(world: World, now: number): ApplyResult {
  const due = world.jobs.filter((job) => job.state === "dispatched" && job.nextRetryAt > 0 && job.nextRetryAt <= now);
  if (due.length === 0) {
    return reject(world, now, "NOTHING_DUE", "没有到期的重试", "", "", "");
  }
  const next = clone(world);
  for (const job of due) {
    const nextJob = mustJob(next, job.id);
    nextJob.nextRetryAt = 0;
    nextJob.updatedAt = now;
    push(next, now, nextJob, "transition", "RETRY_DUE", "退避时间到，渲染池可以重新领取", "dispatched", "dispatched");
  }
  return ok(next, "RETRY_DUE", `已唤醒 ${due.length} 笔到期重试`, due[0]?.id);
}

function closeIncident(world: World, command: Extract<Command, { type: "incident" }>, now: number): ApplyResult {
  const incident = world.incidents.find((item) => item.id === command.incidentId);
  if (!incident) return reject(world, now, "INCIDENT_NOT_FOUND", "事件不存在", "", "", "");
  if (incident.status === "closed") return reject(world, now, "ILLEGAL_STATE", "事件已关闭", "", "", "");
  const next = clone(world);
  const nextIncident = next.incidents.find((item) => item.id === incident.id);
  if (!nextIncident) return reject(world, now, "INCIDENT_NOT_FOUND", "事件不存在", "", "", "");
  nextIncident.status = command.action === "close" ? "closed" : "mitigated";
  next.seq += 1;
  next.events.push({
    id: `evt_${next.seq}`,
    ts: now,
    traceId: "",
    jobId: "",
    merchantId: "",
    kind: "incident",
    code: command.action === "close" ? "INCIDENT_CLOSED" : "INCIDENT_MITIGATED",
    message: `${command.actor}：${command.reason}`,
    from: incident.status,
    to: nextIncident.status,
  });
  next.events = next.events.slice(-400);
  return ok(next, nextIncident.status === "closed" ? "INCIDENT_CLOSED" : "INCIDENT_MITIGATED", "事件状态已更新");
}

function refundHeld(world: World, job: Job, now: number, from: string, message: string) {
  const merchant = mustMerchant(world, job.merchantId);
  merchant.reservedMicro -= job.quoteMicro;
  merchant.creditMicro += job.quoteMicro;
  job.state = "refunded";
  job.updatedAt = now;
  job.nextRetryAt = 0;
  push(world, now, job, "transition", "REFUNDED", message, from, "refunded");
  if (job.lastError === "SIGNATURE_MISMATCH") {
    const id = `inc_sig_${job.id}`;
    if (!world.incidents.some((incident) => incident.id === id)) {
      world.incidents.unshift({
        id,
        severity: "sev2",
        title: "回调签名不匹配",
        status: "open",
        openedAt: now,
        summary: `${job.id} 因 SIGNATURE_MISMATCH 已退款。先核对密钥与时钟，再决定是否冻结商户。`,
      });
    }
  }
}

function openDeadLetterIncident(world: World, job: Job, now: number) {
  const id = `inc_dl_${job.id}`;
  if (world.incidents.some((incident) => incident.id === id)) return;
  world.incidents.unshift({
    id,
    severity: "sev3",
    title: "死信待补偿",
    status: "open",
    openedAt: now,
    summary: `${job.id}（${job.lastError}）预授权仍冻结。值班需在 30 分钟内退款、重试或核销。`,
  });
}

function replay(world: World, prev: IdemRecord, now: number): ApplyResult {
  const job = world.jobs.find((item) => item.id === prev.jobId);
  const next = clone(world);
  next.seq += 1;
  next.events.push({
    id: `evt_${next.seq}`,
    ts: now,
    traceId: job?.traceId ?? "",
    jobId: prev.jobId,
    merchantId: job?.merchantId ?? "",
    kind: "audit",
    code: "IDEMPOTENT_REPLAY",
    message: `幂等回放 ${prev.code}，账本未再次变动`,
    from: job?.state ?? "",
    to: job?.state ?? "",
  });
  next.events = next.events.slice(-400);
  return {
    world: next,
    ok: prev.ok,
    code: prev.code,
    message: prev.message,
    replay: true,
    jobId: prev.jobId || undefined,
  };
}

function reject(
  world: World,
  now: number,
  code: string,
  message: string,
  traceId: string,
  jobId: string,
  merchantId: string,
): ApplyResult {
  const next = clone(world);
  next.seq += 1;
  next.events.push({
    id: `evt_${next.seq}`,
    ts: now,
    traceId,
    jobId,
    merchantId,
    kind: "reject",
    code,
    message,
    from: "",
    to: "",
  });
  next.events = next.events.slice(-400);
  return { world: next, ok: false, code, message, replay: false, jobId: jobId || undefined };
}

function ok(world: World, code: string, message: string, jobId?: string): ApplyResult {
  return { world, ok: true, code, message, replay: false, jobId };
}

function push(world: World, now: number, job: Job, kind: LedgerEvent["kind"], code: string, message: string, from: string, to: string) {
  world.seq += 1;
  world.events.push({
    id: `evt_${world.seq}`,
    ts: now,
    traceId: job.traceId,
    jobId: job.id,
    merchantId: job.merchantId,
    kind,
    code,
    message,
    from,
    to,
  });
  world.events = world.events.slice(-400);
}

function pushMerchant(world: World, now: number, merchantId: string, code: string, message: string) {
  world.seq += 1;
  world.events.push({
    id: `evt_${world.seq}`,
    ts: now,
    traceId: "",
    jobId: "",
    merchantId,
    kind: "audit",
    code,
    message,
    from: "",
    to: "",
  });
  world.events = world.events.slice(-400);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mustJob(world: World, id: string): Job {
  const job = world.jobs.find((item) => item.id === id);
  if (!job) throw new Error(`missing job ${id}`);
  return job;
}

function mustMerchant(world: World, id: string): Merchant {
  const merchant = world.merchants.find((item) => item.id === id);
  if (!merchant) throw new Error(`missing merchant ${id}`);
  return merchant;
}
