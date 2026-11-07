export type DiagnosticEvent = {
  at: string;
  traceId: string;
  stage: string;
  status: "start" | "success" | "failure" | "info";
  elapsedMs?: number;
  details?: Record<string, unknown>;
};

let activeTraceId = "unassigned";
const events: DiagnosticEvent[] = [];
const listeners = new Set<(event: DiagnosticEvent) => void>();
const startedAt = new Map<string, number>();

function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" && value.length > 4000 ? value.slice(0, 4000) + "…[truncated]" : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (depth >= 5) return "[max depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, depth + 1, seen));
  const output: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value).slice(0, 80)) {
    if (/secret|private.?key|seed|mnemonic|password|authorization|cookie|token/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    try {
      output[key] = safeValue((value as Record<string, unknown>)[key], depth + 1, seen);
    } catch {
      output[key] = "[unreadable]";
    }
  }
  return output;
}

export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key === "message" || key === "stack" || key === "name") continue;
      try {
        extra[key] = safeValue((error as unknown as Record<string, unknown>)[key]);
      } catch {
        extra[key] = "[unreadable]";
      }
    }
    const cause = "cause" in error ? safeValue(error.cause) : undefined;
    return {
      name: error.name,
      message: error.message,
      code: "code" in error ? safeValue((error as Error & { code?: unknown }).code) : undefined,
      stack: error.stack,
      cause,
      properties: extra,
    };
  }
  return { thrown: safeValue(error) };
}

export function beginDiagnosticTrace(label: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  activeTraceId = `LS-${Date.now().toString(36)}-${random}`;
  events.splice(0, events.length);
  startedAt.clear();
  recordDiagnostic("TRACE", "start", { label, traceId: activeTraceId });
  return activeTraceId;
}

export function currentTraceId(): string {
  return activeTraceId;
}

export function recordDiagnostic(
  stage: string,
  status: DiagnosticEvent["status"],
  details?: Record<string, unknown>,
): void {
  const now = Date.now();
  const key = `${activeTraceId}:${stage}`;
  if (status === "start") startedAt.set(key, now);
  const elapsedMs = status === "success" || status === "failure"
    ? Math.max(0, now - (startedAt.get(key) ?? now))
    : undefined;
  const event: DiagnosticEvent = {
    at: new Date(now).toISOString(),
    traceId: activeTraceId,
    stage,
    status,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(details ? { details: safeValue(details) as Record<string, unknown> } : {}),
  };
  events.push(event);
  if (events.length > 250) events.splice(0, events.length - 250);
  if (typeof console !== "undefined") {
    const method = status === "failure" ? "error" : status === "success" ? "info" : "debug";
    console[method](`[LedgerShot:${activeTraceId}] ${stage} ${status}`, event);
  }
  for (const listener of listeners) listener(event);
}

export function recordDiagnosticError(stage: string, error: unknown): void {
  recordDiagnostic(stage, "failure", { error: describeError(error) });
}

export function getDiagnosticEvents(): DiagnosticEvent[] {
  return events.map((event) => ({ ...event }));
}

export function subscribeDiagnostics(listener: (event: DiagnosticEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function diagnosticReport(): string {
  return JSON.stringify({ traceId: activeTraceId, events }, null, 2);
}
