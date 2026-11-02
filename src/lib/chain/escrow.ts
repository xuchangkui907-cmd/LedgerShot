/**
 * Same four moves as programs/ledger_shot:
 * init_job -> sync_funded -> release, or refund.
 * Amounts are integer atomic USDC (6 decimals). Release pays only on an exact hash match.
 */

export const PROGRAM_ID = "2QYwB2ZnWEyNRafuDYwus2TjzB5uJaJUqLPw6s8mo4Yx";
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const UPGRADE_AUTHORITY = "2ASr3Aa2mJZPsU5FFfwJvcoHhy8GT9gY4gZw4EYPX4oD";

/** Rehearsal addresses. Public only — no key is stored, and they are not funded. */
export const DEMO_PAYER = "ATFUTiwf6fHp6Hhvvf1DA54LsLApMeYZ3LJgMc3SGeGF";
export const DEMO_MERCHANT = "DeiN4ynLmWcGWaYtow1MbDYmxM1M67BNc3wFnMsNYsdU";

export const OPENING_ATOMIC = 2_000_000;
export const DESK_NOW_UNIX = Math.floor(Date.UTC(2026, 9, 31, 12, 0, 0) / 1000);
export const DEFAULT_DEADLINE = DESK_NOW_UNIX + 60 * 60;

export type Sku = "still" | "dub";
export type Status = "quoted" | "funded" | "released" | "refunded";
export type Ix = "init_job" | "sync_funded" | "release" | "refund";

export type ChainJob = {
  id: string;
  sku: Sku;
  title: string;
  brief: string;
  priceAtomic: number;
  deadlineUnix: number;
  status: Status;
  specHash: string;
  expectedHash: string;
  outputHash: string;
  payer: string;
  merchant: string;
};

export type Books = {
  payer: number;
  vault: number;
  merchant: number;
};

export type LogLine = {
  ok: boolean;
  ix: Ix;
  code: string;
  detail: string;
};

export type Desk = {
  books: Books;
  jobs: ChainJob[];
  log: LogLine[];
};

export type Apply = {
  desk: Desk;
  ok: boolean;
  code: string;
  message: string;
  jobId?: string;
};

export function emptyDesk(): Desk {
  return {
    books: { payer: OPENING_ATOMIC, vault: 0, merchant: 0 },
    jobs: [],
    log: [],
  };
}

export function booksDrift(desk: Desk): number {
  return desk.books.payer + desk.books.vault + desk.books.merchant - OPENING_ATOMIC;
}

export function formatUsdc(atomic: number): string {
  const sign = atomic < 0 ? "-" : "";
  const value = Math.abs(atomic);
  const whole = Math.floor(value / 1_000_000);
  const frac6 = String(value % 1_000_000).padStart(6, "0");
  const trimmed = frac6.replace(/0+$/, "");
  const frac = trimmed.length < 2 ? frac6.slice(0, 2) : trimmed;
  return `${sign}${whole}.${frac}`;
}

export function parseUsdc(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const atomic = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  if (!Number.isSafeInteger(atomic) || atomic < 10_000 || atomic > 1_000_000_000) return null;
  return atomic;
}

export function initJob(
  desk: Desk,
  job: Omit<ChainJob, "status" | "outputHash">,
): Apply {
  if (!/^[0-9a-f]{32}$/.test(job.id)) {
    return fail(desk, "init_job", "BAD_JOB_ID", "Job id must be 16 bytes");
  }
  if (job.priceAtomic <= 0) return fail(desk, "init_job", "ZERO_AMOUNT", "Amount must be > 0");
  if (!job.specHash || !job.expectedHash) {
    return fail(desk, "init_job", "EMPTY_HASH", "Quote is missing a hash");
  }
  if (desk.jobs.some((item) => item.id === job.id)) {
    return fail(desk, "init_job", "BAD_STATUS", "Job already exists");
  }
  const next = clone(desk);
  next.jobs.unshift({ ...job, status: "quoted", outputHash: "" });
  return ok(next, "init_job", "QUOTED", `Quoted ${formatUsdc(job.priceAtomic)} USDC. Vault not funded yet.`, job.id);
}

export function syncFunded(desk: Desk, jobId: string): Apply {
  const job = desk.jobs.find((item) => item.id === jobId);
  if (!job) return fail(desk, "sync_funded", "NOT_FOUND", "Job not found");
  if (job.status !== "quoted") {
    return fail(desk, "sync_funded", "BAD_STATUS", `Status ${job.status} cannot be funded`);
  }
  if (desk.books.payer < job.priceAtomic) {
    return fail(desk, "sync_funded", "UNDERPAID", "Payer clearing is short");
  }
  const next = clone(desk);
  const row = must(next, jobId);
  next.books.payer -= row.priceAtomic;
  next.books.vault += row.priceAtomic;
  row.status = "funded";
  return ok(next, "sync_funded", "FUNDED", `Locked ${formatUsdc(row.priceAtomic)} USDC in the vault.`, jobId);
}

export function release(desk: Desk, jobId: string, outputHash: string): Apply {
  const job = desk.jobs.find((item) => item.id === jobId);
  if (!job) return fail(desk, "release", "NOT_FOUND", "Job not found");
  if (job.status !== "funded") {
    return fail(desk, "release", "BAD_STATUS", `Status ${job.status} cannot release`);
  }
  if (!outputHash) return fail(desk, "release", "EMPTY_HASH", "Empty output hash");
  if (outputHash !== job.expectedHash) {
    return fail(
      desk,
      "release",
      "HASH_MISMATCH",
      "Output hash does not match the quote. Vault stays locked.",
      jobId,
    );
  }
  const next = clone(desk);
  const row = must(next, jobId);
  next.books.vault -= row.priceAtomic;
  next.books.merchant += row.priceAtomic;
  row.status = "released";
  row.outputHash = outputHash;
  return ok(next, "release", "RELEASED", `Paid the studio ${formatUsdc(row.priceAtomic)} USDC.`, jobId);
}

export function refund(desk: Desk, jobId: string): Apply {
  const job = desk.jobs.find((item) => item.id === jobId);
  if (!job) return fail(desk, "refund", "NOT_FOUND", "Job not found");
  if (job.status !== "funded") {
    return fail(desk, "refund", "BAD_STATUS", `Status ${job.status} has nothing to refund`);
  }
  const next = clone(desk);
  const row = must(next, jobId);
  next.books.vault -= row.priceAtomic;
  next.books.payer += row.priceAtomic;
  row.status = "refunded";
  return ok(next, "refund", "REFUNDED", `Returned ${formatUsdc(row.priceAtomic)} USDC to the payer.`, jobId);
}

export const JUDGE_STILL_ID = "11111111111111111111111111111111";
export const JUDGE_DUB_ID = "22222222222222222222222222222222";

export function applyJudgePass(
  hashes: {
    stillSpec: string;
    stillExpected: string;
    stillTamper: string;
    dubSpec: string;
    dubExpected: string;
    dubTamper: string;
  },
): Apply {
  const still = {
    id: JUDGE_STILL_ID,
    sku: "still" as const,
    title: "Kettle hero still",
    brief: "White seamless, 45 degree, soft shadow.",
    priceAtomic: 100_000,
    deadlineUnix: DEFAULT_DEADLINE,
    specHash: hashes.stillSpec,
    expectedHash: hashes.stillExpected,
    payer: DEMO_PAYER,
    merchant: DEMO_MERCHANT,
  };
  const dub = {
    id: JUDGE_DUB_ID,
    sku: "dub" as const,
    title: "EN/ES launch dub",
    brief: "15 seconds, warm read, no music bed.",
    priceAtomic: 100_000,
    deadlineUnix: DEFAULT_DEADLINE,
    specHash: hashes.dubSpec,
    expectedHash: hashes.dubExpected,
    payer: DEMO_PAYER,
    merchant: DEMO_MERCHANT,
  };

  let desk = emptyDesk();
  const steps = [
    initJob(desk, still),
  ];
  desk = steps[0]!.desk;
  let result = syncFunded(desk, still.id);
  desk = result.desk;
  result = release(desk, still.id, hashes.stillExpected);
  if (!result.ok) return result;
  desk = result.desk;
  result = initJob(desk, dub);
  desk = result.desk;
  result = syncFunded(desk, dub.id);
  desk = result.desk;
  const mismatch = release(desk, dub.id, hashes.dubTamper);
  if (mismatch.ok || mismatch.code !== "HASH_MISMATCH") {
    return fail(desk, "release", "HASH_MISMATCH", "Tampered proof was accepted");
  }
  desk = mismatch.desk;
  result = refund(desk, dub.id);
  return result;
}

function ok(desk: Desk, ix: Ix, code: string, message: string, jobId?: string): Apply {
  desk.log.unshift({ ok: true, ix, code, detail: message });
  desk.log = desk.log.slice(0, 24);
  return { desk, ok: true, code, message, jobId };
}

function fail(desk: Desk, ix: Ix, code: string, message: string, jobId?: string): Apply {
  const next = clone(desk);
  next.log.unshift({ ok: false, ix, code, detail: message });
  next.log = next.log.slice(0, 24);
  return { desk: next, ok: false, code, message, jobId };
}

function clone(desk: Desk): Desk {
  return structuredClone(desk);
}

function must(desk: Desk, id: string): ChainJob {
  const job = desk.jobs.find((item) => item.id === id);
  if (!job) throw new Error(`missing job ${id}`);
  return job;
}
