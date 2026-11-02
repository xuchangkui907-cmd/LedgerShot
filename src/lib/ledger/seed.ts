import { apply, emptyWorld, type Command, type Merchant, type World } from "./service.ts";

/** Fixed clock so server render and client hydration share one ledger. */
export const DEMO_NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

const HOUR = 60 * 60 * 1000;

function merchant(partial: Pick<Merchant, "id" | "name" | "desk" | "pool" | "region" | "wallet" | "risk" | "feeBps"> & {
  openingMicro?: number;
}): Merchant {
  const opening = partial.openingMicro ?? 2_000_000_000;
  return {
    id: partial.id,
    name: partial.name,
    desk: partial.desk,
    pool: partial.pool,
    region: partial.region,
    wallet: partial.wallet,
    status: "active",
    resumeStatus: "active",
    risk: partial.risk,
    feeBps: partial.feeBps,
    creditMicro: opening,
    reservedMicro: 0,
    platformRevenueMicro: 0,
    supplierPayableMicro: 0,
    platformLossMicro: 0,
    openingMicro: opening,
  };
}

function must(world: World, command: Command, now: number): World {
  const result = apply(world, command, now);
  if (!result.ok) throw new Error(`${command.type} ${result.code}: ${result.message}`);
  return result.world;
}

export function buildDemo(now = DEMO_NOW): World {
  let world = emptyWorld();
  world.merchants = [
    merchant({
      id: "m_hesheng",
      name: "合声配音社",
      desk: "多语种配音",
      pool: "east-3",
      region: "合肥",
      wallet: "Hs8k…eQ2a",
      risk: "low",
      feeBps: 800,
    }),
    merchant({
      id: "m_jingchuan",
      name: "镜川电商视觉",
      desk: "电商主图",
      pool: "west-1",
      region: "杭州",
      wallet: "Jc3p…91Lm",
      risk: "medium",
      feeBps: 600,
    }),
    merchant({
      id: "m_yehang",
      name: "短剧工场·夜航",
      desk: "短剧成片",
      pool: "east-3",
      region: "成都",
      wallet: "Yh4n…c0Ws",
      risk: "medium",
      feeBps: 1200,
    }),
    merchant({
      id: "m_mingrong",
      name: "名融媒体车间",
      desk: "品牌样片",
      pool: "west-1",
      region: "合肥",
      wallet: "Mr7d…aa10",
      risk: "low",
      feeBps: 500,
    }),
    merchant({
      id: "m_kuajing",
      name: "跨境素材局",
      desk: "跨境短视频",
      pool: "east-3",
      region: "深圳",
      wallet: "Kj2s…77Qp",
      risk: "high",
      feeBps: 900,
    }),
    merchant({
      id: "m_greybox",
      name: "试运营·灰盒",
      desk: "新商户",
      pool: "west-1",
      region: "待定",
      wallet: "Gb1x…00aa",
      risk: "high",
      feeBps: 800,
      openingMicro: 50_000_000,
    }),
  ];

  let cursor = now - 11 * HOUR;
  const at = (stepMs: number) => {
    cursor += stepMs;
    return cursor;
  };

  const flow = (
    merchantId: string,
    sku: "still" | "dub" | "short",
    title: string,
    quoteMicro: number,
    key: string,
  ) => {
    world = must(world, {
      type: "quote",
      merchantId,
      sku,
      title,
      quoteMicro,
      idempotencyKey: `${key}-quote`,
    }, at(20_000));
    const jobId = world.jobs.at(-1)!.id;
    world = must(world, { type: "reserve", jobId, idempotencyKey: `${key}-reserve` }, at(15_000));
    world = must(world, { type: "dispatch", jobId, idempotencyKey: `${key}-dispatch` }, at(10_000));
    return jobId;
  };

  const done = (jobId: string, key: string) => {
    world = must(world, { type: "complete", jobId, idempotencyKey: `${key}-done` }, at(45 * 60_000));
  };

  done(flow("m_hesheng", "dub", "新品口播 · 英西双语", 18_000_000, "hs1"), "hs1");
  done(flow("m_hesheng", "dub", "课程旁白 · 日语", 12_500_000, "hs2"), "hs2");
  done(flow("m_jingchuan", "still", "主图一组 · 水壶", 8_000_000, "jc1"), "jc1");
  done(flow("m_jingchuan", "still", "场景图 · 露营", 9_500_000, "jc2"), "jc2");
  done(flow("m_yehang", "short", "夜航第 4 集预告", 42_000_000, "yh1"), "yh1");
  done(flow("m_mingrong", "still", "展会主视觉静帧", 15_000_000, "mr1"), "mr1");
  done(flow("m_kuajing", "short", "独立站开箱 15s", 22_000_000, "kj1"), "kj1");
  done(flow("m_hesheng", "dub", "客服话术 · 阿语", 7_500_000, "hs3"), "hs3");

  const badAsset = flow("m_jingchuan", "still", "破损素材 · 手表", 6_000_000, "jc3");
  world = must(world, {
    type: "webhook",
    jobId: badAsset,
    outcome: "render.failed",
    errorCode: "INVALID_ASSET",
    idempotencyKey: "jc3-fail",
  }, at(25_000));

  const forged = flow("m_kuajing", "dub", "未验签回调样本", 5_000_000, "kj2");
  world = must(world, {
    type: "webhook",
    jobId: forged,
    outcome: "render.failed",
    errorCode: "SIGNATURE_MISMATCH",
    idempotencyKey: "kj2-fail",
  }, at(25_000));

  const stuck = flow("m_kuajing", "short", "east-3 超时 · 厨具", 16_000_000, "kj3");
  world = must(world, {
    type: "fail",
    jobId: stuck,
    errorCode: "RENDER_NODE_TIMEOUT",
    idempotencyKey: "kj3-f1",
  }, at(20_000));
  world = must(world, {
    type: "fail",
    jobId: stuck,
    errorCode: "RENDER_NODE_TIMEOUT",
    idempotencyKey: "kj3-f2",
  }, at(30_000));
  world = must(world, {
    type: "fail",
    jobId: stuck,
    errorCode: "RENDER_NODE_TIMEOUT",
    idempotencyKey: "kj3-f3",
  }, at(30_000));

  const inflight = flow("m_hesheng", "dub", "直播切片 · 进行中", 11_000_000, "hs4");
  void inflight;

  const held = flow("m_yehang", "short", "第 5 集 · 结算暂停", 28_000_000, "yh2");
  void held;
  world = must(world, {
    type: "operator",
    action: "hold",
    merchantId: "m_yehang",
    reason: "本周分成账户待财务确认",
    actor: "值班-周宁",
    idempotencyKey: "yh-hold",
  }, at(10_000));

  world = must(world, {
    type: "operator",
    action: "freeze",
    merchantId: "m_mingrong",
    reason: "展会样片出现未授权人脸，先止付",
    actor: "风控-林夏",
    idempotencyKey: "mr-freeze",
  }, at(10_000));

  world = must(world, {
    type: "quote",
    merchantId: "m_greybox",
    sku: "still",
    title: "灰盒试单 · 尚未冻结",
    quoteMicro: 4_000_000,
    idempotencyKey: "gb-quote",
  }, at(10_000));

  world = must(world, {
    type: "quote",
    merchantId: "m_mingrong",
    sku: "still",
    title: "冻结后的新报价",
    quoteMicro: 3_000_000,
    idempotencyKey: "mr-quote-blocked",
  }, at(10_000));

  const waiting = flow("m_jingchuan", "still", "待派发 · 家居套图", 7_200_000, "jc4");
  // flow() already dispatched. Re-read: I need a reserved-only job.
  // Compensate by not using this as dispatched — leave it, and add a true reserved job below.
  void waiting;

  world = must(world, {
    type: "quote",
    merchantId: "m_jingchuan",
    sku: "still",
    title: "只冻结未派发 · 餐具",
    quoteMicro: 5_400_000,
    idempotencyKey: "jc5-quote",
  }, at(12_000));
  const reservedOnly = world.jobs.at(-1)!.id;
  world = must(world, { type: "reserve", jobId: reservedOnly, idempotencyKey: "jc5-reserve" }, at(8_000));

  // One retry still waiting, so the queue shows a future backoff.
  const cooling = flow("m_hesheng", "dub", "节点抖动 · 退避中", 9_800_000, "hs5");
  world = must(world, {
    type: "fail",
    jobId: cooling,
    errorCode: "RPC_UNAVAILABLE",
    idempotencyKey: "hs5-fail",
  }, now - 5_000);

  return world;
}
