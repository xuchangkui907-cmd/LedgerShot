import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "./contract.ts";

describe("billing contract", () => {
  it("accepts a render failure webhook", () => {
    const parsed = parseCommand({
      type: "webhook",
      jobId: "job_1",
      outcome: "render.failed",
      errorCode: "RENDER_NODE_TIMEOUT",
      idempotencyKey: "wh_12345678",
      occurredAt: 1_700_000_000_000,
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.command.type, "webhook");
  });

  it("rejects float money, short idempotency keys, and unknown commands", () => {
    const money = parseCommand({
      type: "quote",
      merchantId: "m_hesheng",
      sku: "dub",
      title: "口播",
      quoteMicro: 12.5,
      idempotencyKey: "quote-key-1",
    });
    assert.equal(money.ok, false);

    const key = parseCommand({
      type: "complete",
      jobId: "job_1",
      idempotencyKey: "short",
    });
    assert.equal(key.ok, false);
    if (!key.ok) assert.match(key.issues.join(" "), /idempotencyKey/);

    const unknown = parseCommand({ type: "mint", amount: 1 });
    assert.equal(unknown.ok, false);
  });

  it("requires a human reason on operator commands", () => {
    const parsed = parseCommand({
      type: "operator",
      action: "freeze",
      merchantId: "m_hesheng",
      reason: "否",
      actor: "值班",
    });
    assert.equal(parsed.ok, false);
  });
});
