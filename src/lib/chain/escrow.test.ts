import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { deliverableText, specText, tamperedText } from "./deliverable.ts";
import {
  OPENING_ATOMIC,
  applyJudgePass,
  booksDrift,
  emptyDesk,
  formatUsdc,
  initJob,
  parseUsdc,
  refund,
  release,
  syncFunded,
  DEMO_MERCHANT,
  DEMO_PAYER,
  DEFAULT_DEADLINE,
} from "./escrow.ts";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function job(over: Partial<Parameters<typeof initJob>[1]> = {}) {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sku: "still" as const,
    title: "Kettle",
    brief: "Soft shadow",
    priceAtomic: 100_000,
    deadlineUnix: DEFAULT_DEADLINE,
    specHash: "11".repeat(32),
    expectedHash: "22".repeat(32),
    payer: DEMO_PAYER,
    merchant: DEMO_MERCHANT,
    ...over,
  };
}

describe("escrow desk", () => {
  it("parses USDC without float dust", () => {
    assert.equal(parseUsdc("0.10"), 100_000);
    assert.equal(formatUsdc(100_000), "0.10");
    assert.equal(formatUsdc(1_900_000), "1.90");
    assert.equal(formatUsdc(0), "0.00");
    assert.equal(parseUsdc("0.009"), null);
    assert.equal(parseUsdc("1.1234567"), null);
  });

  it("locks, pays on a matching hash, and refuses a tampered one", () => {
    let desk = emptyDesk();
    const quoted = initJob(desk, job());
    assert.equal(quoted.ok, true);
    assert.equal(booksDrift(quoted.desk), 0);
    desk = quoted.desk;

    const funded = syncFunded(desk, job().id);
    assert.equal(funded.desk.books.vault, 100_000);
    assert.equal(funded.desk.books.payer, OPENING_ATOMIC - 100_000);
    desk = funded.desk;

    const bad = release(desk, job().id, "33".repeat(32));
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "HASH_MISMATCH");
    assert.equal(bad.desk.books.vault, 100_000);
    assert.equal(bad.desk.books.merchant, 0);

    const good = release(desk, job().id, job().expectedHash);
    assert.equal(good.ok, true);
    assert.equal(good.desk.books.merchant, 100_000);
    assert.equal(good.desk.books.vault, 0);
    assert.equal(refund(good.desk, job().id).ok, false);
    assert.equal(booksDrift(good.desk), 0);
  });

  it("refunds a funded job back to the same books", () => {
    let desk = syncFunded(initJob(emptyDesk(), job()).desk, job().id).desk;
    const back = refund(desk, job().id);
    assert.equal(back.ok, true);
    assert.equal(back.desk.books.payer, OPENING_ATOMIC);
    assert.equal(back.desk.books.vault, 0);
    assert.equal(booksDrift(back.desk), 0);
  });

  it("runs the judge pass: one release, one mismatch, one refund, zero drift", () => {
    const still = { sku: "still" as const, title: "Kettle hero still", brief: "White seamless, 45 degree, soft shadow." };
    const dub = { sku: "dub" as const, title: "EN/ES launch dub", brief: "15 seconds, warm read, no music bed." };
    const stillBody = deliverableText(still);
    const dubBody = deliverableText(dub);
    const result = applyJudgePass({
      stillSpec: sha(specText({ ...still, priceAtomic: 100_000 })),
      stillExpected: sha(stillBody),
      stillTamper: sha(tamperedText(stillBody)),
      dubSpec: sha(specText({ ...dub, priceAtomic: 100_000 })),
      dubExpected: sha(dubBody),
      dubTamper: sha(tamperedText(dubBody)),
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, "REFUNDED");
    assert.equal(result.desk.books.merchant, 100_000);
    assert.equal(result.desk.books.vault, 0);
    assert.equal(result.desk.books.payer, OPENING_ATOMIC - 100_000);
    assert.equal(booksDrift(result.desk), 0);
    assert.equal(result.desk.jobs.find((item) => item.sku === "still")?.status, "released");
    assert.equal(result.desk.jobs.find((item) => item.sku === "dub")?.status, "refunded");
    assert.ok(result.desk.log.some((line) => line.code === "HASH_MISMATCH"));
  });
});
