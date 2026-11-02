import { z } from "zod";

/**
 * Wire contract for the merchant billing desk.
 * Amounts are integer micro-USDC (1 USDC = 1_000_000). No floats on the boundary.
 */

export const skuSchema = z.enum(["still", "dub", "short"]);

export const quoteCommandSchema = z.object({
  type: z.literal("quote"),
  merchantId: z.string().trim().min(1).max(64),
  sku: skuSchema,
  title: z.string().trim().min(1).max(80),
  quoteMicro: z.number().int().min(10_000).max(50_000_000_000),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const reserveCommandSchema = z.object({
  type: z.literal("reserve"),
  jobId: z.string().trim().min(1).max(64),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const dispatchCommandSchema = z.object({
  type: z.literal("dispatch"),
  jobId: z.string().trim().min(1).max(64),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const completeCommandSchema = z.object({
  type: z.literal("complete"),
  jobId: z.string().trim().min(1).max(64),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const failCommandSchema = z.object({
  type: z.literal("fail"),
  jobId: z.string().trim().min(1).max(64),
  errorCode: z.string().trim().min(2).max(64),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const webhookCommandSchema = z.object({
  type: z.literal("webhook"),
  jobId: z.string().trim().min(1).max(64),
  outcome: z.enum(["render.completed", "render.failed"]),
  errorCode: z.string().trim().min(2).max(64).optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
  occurredAt: z.number().int().nonnegative().optional(),
});

export const operatorCommandSchema = z.object({
  type: z.literal("operator"),
  action: z.enum(["retry", "refund", "write_off", "freeze", "unfreeze", "hold", "release_hold", "replay"]),
  jobId: z.string().trim().min(1).max(64).optional(),
  merchantId: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(3).max(200),
  actor: z.string().trim().min(2).max(40),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

export const tickCommandSchema = z.object({
  type: z.literal("tick"),
});

export const incidentCommandSchema = z.object({
  type: z.literal("incident"),
  action: z.enum(["mitigate", "close"]),
  incidentId: z.string().trim().min(1).max(64),
  actor: z.string().trim().min(2).max(40),
  reason: z.string().trim().min(3).max(200),
});

export const commandSchema = z.discriminatedUnion("type", [
  quoteCommandSchema,
  reserveCommandSchema,
  dispatchCommandSchema,
  completeCommandSchema,
  failCommandSchema,
  webhookCommandSchema,
  operatorCommandSchema,
  tickCommandSchema,
  incidentCommandSchema,
]);

export type Command = z.infer<typeof commandSchema>;

export function parseCommand(input: unknown):
  | { ok: true; command: Command }
  | { ok: false; issues: string[] } {
  const parsed = commandSchema.safeParse(input);
  if (parsed.success) return { ok: true, command: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
  };
}

export function idempotencyKeyOf(command: Command): string | undefined {
  if (command.type === "tick" || command.type === "incident") return undefined;
  if (command.type === "operator") return command.idempotencyKey;
  return command.idempotencyKey;
}

export function fingerprintOf(command: Command): string {
  switch (command.type) {
    case "quote":
      return `quote|${command.merchantId}|${command.sku}|${command.title}|${command.quoteMicro}`;
    case "reserve":
      return `reserve|${command.jobId}`;
    case "dispatch":
      return `dispatch|${command.jobId}`;
    case "complete":
      return `complete|${command.jobId}`;
    case "fail":
      return `fail|${command.jobId}|${command.errorCode}`;
    case "webhook":
      return `webhook|${command.jobId}|${command.outcome}|${command.errorCode ?? ""}`;
    case "operator":
      return `operator|${command.action}|${command.jobId ?? ""}|${command.merchantId ?? ""}|${command.actor}|${command.reason}`;
    case "tick":
      return "tick";
    case "incident":
      return `incident|${command.action}|${command.incidentId}|${command.actor}|${command.reason}`;
  }
}
