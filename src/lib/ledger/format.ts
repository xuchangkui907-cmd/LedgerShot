import type { JobState, MerchantStatus, RiskTier } from "./service.ts";

const time = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Shanghai",
});

export function formatUsdc(micro: number | string | bigint): string {
  let atomic: bigint;

  if (typeof micro === "number") {
    if (!Number.isSafeInteger(micro)) {
      throw new RangeError("USDC amount must be a safe integer when supplied as number");
    }
    atomic = BigInt(micro);
  } else if (typeof micro === "bigint") {
    atomic = micro;
  } else {
    if (!/^-?\d+$/.test(micro)) {
      throw new TypeError("USDC amount must be an integer string");
    }
    atomic = BigInt(micro);
  }

  const negative = atomic < 0n;
  const absolute = negative ? -atomic : atomic;

  // USDC uses 6 decimals. Round to 4 display decimals without converting to Number.
  const displayUnits = (absolute + 50n) / 100n;
  const whole = displayUnits / 10_000n;
  let fraction = (displayUnits % 10_000n).toString().padStart(4, "0");
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");

  const wholeText = new Intl.NumberFormat("zh-CN").format(whole);
  const text = `${negative ? "-" : ""}${wholeText}.${fraction}`;
  return `${text} USDC`;
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export function formatTime(ts: number): string {
  if (!ts) return "—";
  return time.format(ts);
}

export const STATE_LABEL: Record<JobState, string> = {
  quoted: "已报价",
  reserved: "已冻结",
  dispatched: "渲染中",
  settled: "已结算",
  refunded: "已退款",
  dead_letter: "死信",
  written_off: "已核销",
};

export const MERCHANT_LABEL: Record<MerchantStatus, string> = {
  active: "营业",
  frozen: "冻结",
  settlement_hold: "结算暂停",
};

export const RISK_LABEL: Record<RiskTier, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

export function stateTone(state: JobState): string {
  if (state === "settled" || state === "refunded") return "text-ok";
  if (state === "dead_letter" || state === "written_off") return "text-danger";
  if (state === "dispatched" || state === "reserved") return "text-accent";
  return "text-muted";
}
