import { feeOf, HOLDING_STATES, type Job, type Merchant, type World } from "./service.ts";

export type Violation = { code: string; message: string };

const HOUR = 60 * 60 * 1000;
export const SLO_TARGET = 0.995;

export function audit(world: World): Violation[] {
  const violations: Violation[] = [];
  for (const merchant of world.merchants) {
    const book =
      merchant.creditMicro +
      merchant.reservedMicro +
      merchant.platformRevenueMicro +
      merchant.supplierPayableMicro +
      merchant.platformLossMicro;
    if (book !== merchant.openingMicro) {
      violations.push({
        code: "BOOK_IMBALANCE",
        message: `${merchant.id} 账面 ${book} ≠ 期初 ${merchant.openingMicro}`,
      });
    }
    if (
      merchant.creditMicro < 0 ||
      merchant.reservedMicro < 0 ||
      merchant.platformRevenueMicro < 0 ||
      merchant.supplierPayableMicro < 0 ||
      merchant.platformLossMicro < 0
    ) {
      violations.push({ code: "NEGATIVE_BALANCE", message: `${merchant.id} 出现负余额` });
    }
    const held = world.jobs
      .filter((job) => job.merchantId === merchant.id && HOLDING_STATES.includes(job.state))
      .reduce((sum, job) => sum + job.quoteMicro, 0);
    if (held !== merchant.reservedMicro) {
      violations.push({
        code: "RESERVATION_DRIFT",
        message: `${merchant.id} 冻结 ${merchant.reservedMicro} ≠ 在途任务 ${held}`,
      });
    }
    for (const job of world.jobs.filter((item) => item.merchantId === merchant.id && item.state === "settled")) {
      const fee = feeOf(job.quoteMicro, job.feeBpsLocked);
      if (job.feeMicro !== fee || job.feeMicro + job.supplierMicro !== job.quoteMicro) {
        violations.push({
          code: "SETTLED_FEE_MISMATCH",
          message: `${job.id} 结算拆分与锁定费率不一致`,
        });
      }
    }
  }
  return violations;
}

export type SloReport = {
  sample: number;
  good: number;
  bad: number;
  rate: number;
  target: number;
  errorBudgetRemaining: number;
  deadLetters: number;
  heldMicro: number;
  revenueMicro: number;
  lossMicro: number;
};

export function slo(world: World): SloReport {
  const considered = world.jobs.filter((job) => job.state !== "quoted");
  const good = considered.filter((job) => job.state === "settled" || job.state === "refunded").length;
  const bad = considered.filter((job) => job.state === "dead_letter" || job.state === "written_off").length;
  const sample = good + bad;
  const rate = sample === 0 ? 1 : good / sample;
  const spent = sample === 0 ? 0 : bad / sample;
  const allowed = 1 - SLO_TARGET;
  const errorBudgetRemaining = allowed === 0 ? 0 : Math.max(0, 1 - spent / allowed);
  return {
    sample,
    good,
    bad,
    rate,
    target: SLO_TARGET,
    errorBudgetRemaining,
    deadLetters: world.jobs.filter((job) => job.state === "dead_letter").length,
    heldMicro: sumMerchant(world.merchants, "reservedMicro"),
    revenueMicro: sumMerchant(world.merchants, "platformRevenueMicro"),
    lossMicro: sumMerchant(world.merchants, "platformLossMicro"),
  };
}

function sumMerchant(merchants: Merchant[], key: "reservedMicro" | "platformRevenueMicro" | "platformLossMicro") {
  return merchants.reduce((sum, merchant) => sum + merchant[key], 0);
}

export type HourBucket = { label: string; ok: number; bad: number };

export function hourlySeries(world: World, end: number): HourBucket[] {
  const buckets = Array.from({ length: 12 }, (_, index) => {
    const start = end - (12 - index) * HOUR;
    const hour = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Shanghai",
    }).format(new Date(start + HOUR / 2));
    return { label: hour, ok: 0, bad: 0, start };
  });

  for (const job of world.jobs) {
    const stamp = job.settledAt || job.updatedAt;
    const bucket = buckets.find((item) => stamp >= item.start && stamp < item.start + HOUR);
    if (!bucket) continue;
    if (job.state === "settled" || job.state === "refunded") bucket.ok += 1;
    else if (job.state === "dead_letter" || job.state === "written_off") bucket.bad += 1;
  }
  return buckets.map(({ label, ok, bad }) => ({ label, ok, bad }));
}

export function holdingJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => HOLDING_STATES.includes(job.state));
}
