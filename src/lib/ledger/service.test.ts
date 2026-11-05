import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audit, slo } from "./observe.ts";
import { buildDemo, DEMO_NOW } from "./seed.ts";
import { apply, applyParsed, emptyWorld, feeOf, type Merchant, type World } from "./service.ts";

const NOW = DEMO_NOW;

function desk(): World {
  const world = emptyWorld();
  world.merchants.push(buyer("m1", 1_000_000_000, 800));
  return world;
}

function buyer(id: string, openingMicro: number, feeBps: number): Merchant {
  return {
    id,
    name: id,
    desk: "测试",
    pool: "east-3",
    region: "合肥",
    wallet: "wal",
    status: "active",
    resumeStatus: "active",
    risk: "low",
    feeBps,
    creditMicro: openingMicro,
    reservedMicro: 0,
    platformRevenueMicro: 0,
    supplierPayableMicro: 0,
    platformLossMicro: 0,
    openingMicro,
  };
}

function openJob(world: World, quoteMicro = 10_000_000) {
  let next = apply(world, {
    type: "quote",
    merchantId: "m1",
    sku: "dub",
    title: "测试任务",
    quoteMicro,
    idempotencyKey: `quote-${quoteMicro}-${world.seq}`,
  }, NOW).world;
  const jobId = next.jobs.at(-1)!.id;
  next = apply(next, { type: "reserve", jobId, idempotencyKey: `reserve-${jobId}` }, NOW).world;
  next = apply(next, { type: "dispatch", jobId, idempotencyKey: `dispatch-${jobId}` }, NOW).world;
  return { world: next, jobId };
}

describe("ledger service", () => {
  it("settles once under a replayed webhook and keeps the fee split", () => {
    const opened = openJob(desk(), 12_500_000);
    const first = apply(opened.world, {
      type: "webhook",
      jobId: opened.jobId,
      outcome: "render.completed",
      idempotencyKey: "wh-settle-1",
    }, NOW);
    assert.equal(first.ok, true);
    assert.equal(first.code, "SETTLED");
    const merchant = first.world.merchants[0]!;
    const fee = feeOf(12_500_000, 800);
    assert.equal(merchant.platformRevenueMicro, fee);
    assert.equal(merchant.supplierPayableMicro, 12_500_000 - fee);
    assert.equal(merchant.reservedMicro, 0);

    const replay = apply(first.world, {
      type: "webhook",
      jobId: opened.jobId,
      outcome: "render.completed",
      idempotencyKey: "wh-settle-1",
    }, NOW + 1);
    assert.equal(replay.replay, true);
    assert.equal(replay.world.merchants[0]!.platformRevenueMicro, fee);
    assert.equal(audit(replay.world).length, 0);

    const conflict = apply(replay.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "INVALID_ASSET",
      idempotencyKey: "wh-settle-1",
    }, NOW + 2);
    assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  });

  it("refunds permanent failures and does not charge the merchant twice", () => {
    const opened = openJob(desk(), 6_000_000);
    const before = opened.world.merchants[0]!.creditMicro;
    const failed = apply(opened.world, {
      type: "webhook",
      jobId: opened.jobId,
      outcome: "render.failed",
      errorCode: "INVALID_ASSET",
      idempotencyKey: "wh-bad-asset",
    }, NOW);
    assert.equal(failed.code, "REFUNDED");
    assert.equal(failed.world.merchants[0]!.creditMicro, before + 6_000_000);
    assert.equal(failed.world.merchants[0]!.reservedMicro, 0);
    const again = apply(failed.world, {
      type: "webhook",
      jobId: opened.jobId,
      outcome: "render.failed",
      errorCode: "INVALID_ASSET",
      idempotencyKey: "wh-bad-asset",
    }, NOW);
    assert.equal(again.replay, true);
    assert.equal(again.world.merchants[0]!.creditMicro, before + 6_000_000);
    assert.equal(audit(again.world).length, 0);
  });

  it("retries transient errors then dead-letters with funds still reserved", () => {
    const opened = openJob(desk());
    let world = opened.world;
    let last = apply(world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "RENDER_NODE_TIMEOUT",
      idempotencyKey: "t-1",
    }, NOW);
    assert.equal(last.code, "RETRY_SCHEDULED");
    const replay = apply(last.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "RENDER_NODE_TIMEOUT",
      idempotencyKey: "t-1",
    }, NOW);
    assert.equal(replay.replay, true);
    assert.equal(replay.world.jobs[0]!.attempts, 1);

    world = apply(replay.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "WEBHOOK_5XX",
      idempotencyKey: "t-2",
    }, NOW).world;
    last = apply(world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "RPC_UNAVAILABLE",
      idempotencyKey: "t-3",
    }, NOW);
    assert.equal(last.code, "DEAD_LETTER");
    assert.equal(last.world.jobs[0]!.state, "dead_letter");
    assert.equal(last.world.merchants[0]!.reservedMicro, 10_000_000);
    assert.equal(last.world.incidents[0]!.severity, "sev3");
    assert.equal(audit(last.world).length, 0);
  });

  it("probes an unknown error once, then dead-letters", () => {
    const opened = openJob(desk());
    const first = apply(opened.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "SOMETHING_NEW",
      idempotencyKey: "u-1",
    }, NOW);
    assert.equal(first.code, "RETRY_SCHEDULED");
    const second = apply(first.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "SOMETHING_NEW",
      idempotencyKey: "u-2",
    }, NOW);
    assert.equal(second.code, "DEAD_LETTER");
  });

  it("blocks settlement while held, then allows the same webhook key", () => {
    let world = desk();
    world = apply(world, {
      type: "operator",
      action: "hold",
      merchantId: "m1",
      reason: "财务暂停",
      actor: "值班",
      idempotencyKey: "hold-1",
    }, NOW).world;
    const opened = openJob(world);
    const blocked = apply(opened.world, {
      type: "complete",
      jobId: opened.jobId,
      idempotencyKey: "settle-later",
    }, NOW);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "SETTLEMENT_HELD");
    assert.equal(blocked.world.merchants[0]!.reservedMicro, 10_000_000);

    const released = apply(blocked.world, {
      type: "operator",
      action: "release_hold",
      merchantId: "m1",
      reason: "财务已确认",
      actor: "值班",
    }, NOW);
    assert.equal(released.ok, true);
    const settled = apply(released.world, {
      type: "complete",
      jobId: opened.jobId,
      idempotencyKey: "settle-later",
    }, NOW);
    assert.equal(settled.code, "SETTLED");
    assert.equal(audit(settled.world).length, 0);
  });

  it("refuses new reserves and settlements while frozen, and supports operator compensation", () => {
    const opened = openJob(desk());
    const frozen = apply(opened.world, {
      type: "operator",
      action: "freeze",
      merchantId: "m1",
      reason: "未授权肖像",
      actor: "风控",
    }, NOW);
    assert.equal(frozen.ok, true);
    const quoted = apply(frozen.world, {
      type: "quote",
      merchantId: "m1",
      sku: "still",
      title: "冻结后的报价",
      quoteMicro: 2_000_000,
      idempotencyKey: "q-frozen",
    }, NOW);
    const reserved = apply(quoted.world, {
      type: "reserve",
      jobId: quoted.jobId!,
      idempotencyKey: "r-frozen",
    }, NOW);
    assert.equal(reserved.code, "MERCHANT_FROZEN");
    const settled = apply(reserved.world, {
      type: "complete",
      jobId: opened.jobId,
      idempotencyKey: "no-settle",
    }, NOW);
    assert.equal(settled.code, "MERCHANT_FROZEN");

    const thawed = apply(settled.world, {
      type: "operator",
      action: "unfreeze",
      merchantId: "m1",
      reason: "肖像授权已补",
      actor: "风控",
    }, NOW).world;
    const dead = apply(thawed, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "INVALID_ASSET",
      idempotencyKey: "now-refund",
    }, NOW);
    assert.equal(dead.code, "REFUNDED");

    const again = openJob(desk());
    let letter = again.world;
    for (const key of ["a", "b", "c"]) {
      letter = apply(letter, {
        type: "fail",
        jobId: again.jobId,
        errorCode: "RPC_UNAVAILABLE",
        idempotencyKey: `dl-${key}`,
      }, NOW).world;
    }
    const written = apply(letter, {
      type: "operator",
      action: "write_off",
      jobId: again.jobId,
      reason: "素材已销毁且无法退款",
      actor: "财务",
      idempotencyKey: "write-1",
    }, NOW);
    assert.equal(written.code, "WRITTEN_OFF");
    assert.equal(written.world.merchants[0]!.platformLossMicro, 10_000_000);
    assert.equal(written.world.merchants[0]!.creditMicro, 1_000_000_000 - 10_000_000);
    const replay = apply(written.world, {
      type: "operator",
      action: "write_off",
      jobId: again.jobId,
      reason: "素材已销毁且无法退款",
      actor: "财务",
      idempotencyKey: "write-1",
    }, NOW);
    assert.equal(replay.replay, true);
    assert.equal(audit(replay.world).length, 0);
  });

  it("rejects an insufficient reserve without burning the key", () => {
    const world = desk();
    world.merchants[0]!.creditMicro = 1_000;
    world.merchants[0]!.openingMicro = 1_000;
    const quoted = apply(world, {
      type: "quote",
      merchantId: "m1",
      sku: "still",
      title: "过大",
      quoteMicro: 20_000,
      idempotencyKey: "big-quote",
    }, NOW).world;
    const jobId = quoted.jobs[0]!.id;
    const denied = apply(quoted, { type: "reserve", jobId, idempotencyKey: "big-reserve" }, NOW);
    assert.equal(denied.code, "INSUFFICIENT_CREDIT");
    quoted.merchants[0]!.creditMicro = 50_000;
    quoted.merchants[0]!.openingMicro = 50_000;
    const allowed = apply(quoted, { type: "reserve", jobId, idempotencyKey: "big-reserve" }, NOW);
    assert.equal(allowed.code, "RESERVED");
  });

  it("flags a corrupted book and accepts the demo world", () => {
    const demo = buildDemo();
    assert.equal(audit(demo).length, 0);
    assert.ok(demo.jobs.some((job) => job.state === "dead_letter"));
    assert.ok(demo.jobs.some((job) => job.state === "settled"));
    assert.ok(demo.incidents.some((incident) => incident.status === "open"));
    const report = slo(demo);
    assert.ok(report.sample >= report.good);
    assert.ok(report.rate > 0.9);

    const broken = structuredClone(demo);
    broken.merchants[0]!.creditMicro += 1;
    const violations = audit(broken);
    assert.ok(violations.some((item) => item.code === "BOOK_IMBALANCE"));
  });

  it("rejects a contract-invalid command before any balance moves", () => {
    const world = desk();
    const result = applyParsed(world, {
      type: "quote",
      merchantId: "m1",
      sku: "dub",
      title: "",
      quoteMicro: 10_000_000,
      idempotencyKey: "bad-contract",
    }, NOW);
    assert.equal(result.code, "CONTRACT_VIOLATION");
    assert.equal(result.world.jobs.length, 0);
    assert.equal(result.world.merchants[0]!.creditMicro, world.merchants[0]!.creditMicro);
  });

  it("wakes only due retries", () => {
    const opened = openJob(desk());
    const failed = apply(opened.world, {
      type: "fail",
      jobId: opened.jobId,
      errorCode: "RPC_UNAVAILABLE",
      idempotencyKey: "due-1",
    }, NOW);
    assert.ok(failed.world.jobs[0]!.nextRetryAt > NOW);
    const early = apply(failed.world, { type: "tick" }, NOW);
    assert.equal(early.code, "NOTHING_DUE");
    const due = apply(failed.world, { type: "tick" }, failed.world.jobs[0]!.nextRetryAt);
    assert.equal(due.code, "RETRY_DUE");
    assert.equal(due.world.jobs[0]!.nextRetryAt, 0);
    assert.equal(due.world.merchants[0]!.reservedMicro, 10_000_000);
  });
});
