/** Failure classes for pay-per-render settlement. Transient errors retry; permanent errors refund. */

export const MAX_ATTEMPTS = 3;

export const ERROR_CATALOG = {
  RENDER_NODE_TIMEOUT: {
    failureClass: "transient",
    hint: "渲染节点超时。指数退避后重试，耗尽进入死信并继续冻结预授权。",
  },
  RPC_UNAVAILABLE: {
    failureClass: "transient",
    hint: "结算 RPC 不可用。不得把预授权当成已消费。",
  },
  WEBHOOK_5XX: {
    failureClass: "transient",
    hint: "下游回调 5xx。同一幂等键只计一次尝试。",
  },
  INVALID_ASSET: {
    failureClass: "permanent",
    hint: "素材无法解码。立即全额退回预授权，不重试。",
  },
  QUOTA_EXCEEDED: {
    failureClass: "permanent",
    hint: "商户额度不足或策略拒绝。立即退款。",
  },
  SIGNATURE_MISMATCH: {
    failureClass: "permanent",
    hint: "回调签名不匹配。拒绝结算并退回预授权，升级为安全事件。",
  },
  UPSTREAM_UNKNOWN: {
    failureClass: "unknown",
    hint: "未识别错误。允许一次探测，第二次进入死信等待人工。",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export type FailureClass = (typeof ERROR_CATALOG)[ErrorCode]["failureClass"];

export function classify(code: string): FailureClass {
  if (code in ERROR_CATALOG) return ERROR_CATALOG[code as ErrorCode].failureClass;
  return "unknown";
}

export function failureHint(code: string): string {
  if (code in ERROR_CATALOG) return ERROR_CATALOG[code as ErrorCode].hint;
  return "未登记错误码，按未知错误处理：探测一次后进入死信。";
}

/** Backoff capped at 15 minutes. Attempt is 1-based after the failure is recorded. */
export function retryDelayMs(attempt: number): number {
  const shift = Math.min(Math.max(attempt, 1), 6);
  return Math.min(30_000 * 2 ** (shift - 1), 15 * 60_000);
}
