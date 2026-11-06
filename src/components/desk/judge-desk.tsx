import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { deliverableText, sha256Hex, specText, tamperedText } from "@/lib/chain/deliverable";
import {
  DEMO_MERCHANT,
  DEMO_PAYER,
  DEFAULT_DEADLINE,
  JUDGE_DUB_ID,
  JUDGE_STILL_ID,
  PROGRAM_ID,
  USDC_MINT,
  booksDrift,
  emptyDesk,
  formatUsdc,
  initJob,
  parseUsdc,
  refund,
  release,
  syncFunded,
  type ChainJob,
  type Desk,
  type Sku,
  type Status,
} from "@/lib/chain/escrow";
import { liveFund, liveInitJob, liveRefund, liveRelease, type LiveResult } from "@/lib/chain/live.ts";
import { confirmAndRecordTx } from "@/lib/chain/observe-fn.ts";
import type { ChainSnapshot } from "@/lib/chain/rpc.ts";
import { LivePanel, type DeskMode } from "./live-panel.tsx";

const EXPLORER = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;
const MINT_EXPLORER = `https://explorer.solana.com/address/${USDC_MINT}?cluster=devnet`;

const STATUS_LABEL: Record<Status, string> = {
  quoted: "Quoted",
  funded: "Funded",
  released: "Released",
  refunded: "Refunded",
};

export function JudgeDesk() {
  const [desk, setDesk] = useState<Desk>(() => emptyDesk());
  const [selected, setSelected] = useState<string | null>(null);
  const [sku, setSku] = useState<Sku>("still");
  const [title, setTitle] = useState("Kettle hero still");
  const [brief, setBrief] = useState("White seamless, 45 degree, soft shadow.");
  const [price, setPrice] = useState("0.10");
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const quoteInFlight = useRef(false);
  const [tamperHash, setTamperHash] = useState("");
  const [mode, setMode] = useState<DeskMode>("rehearsal");
  const [payerAddr, setPayerAddr] = useState(DEMO_PAYER);
  const [merchantAddr, setMerchantAddr] = useState(DEMO_MERCHANT);
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);

  const job = desk.jobs.find((item) => item.id === selected) ?? null;
  const drift = booksDrift(desk);

  useEffect(() => {
    if (!job) {
      setTamperHash("");
      return;
    }
    let cancel = false;
    void sha256Hex(tamperedText(deliverableText(job))).then((hex) => {
      if (!cancel) setTamperHash(hex);
    });
    return () => {
      cancel = true;
    };
  }, [job]);

  function apply(result: { desk: Desk; ok: boolean; message: string; jobId?: string }) {
    setDesk(result.desk);
    setBanner({ ok: result.ok, text: result.message });
    if (result.jobId) setSelected(result.jobId);
  }

  async function persistLive(result: LiveResult, chainJob: ChainJob) {
    if (!result.signature) {
      return { verified: false, issues: ["No transaction signature was returned."], status: "missing" };
    }

    try {
      const recorded = await confirmAndRecordTx({
        data: {
          signature: result.signature,
          instruction: result.instruction,
          chainJobId: chainJob.id,
          payer: chainJob.payer,
          merchant: chainJob.merchant,
          amountAtomic: chainJob.priceAtomic,
          outputHash: chainJob.outputHash || chainJob.expectedHash,
          errorCode: result.ok ? undefined : result.code,
          logs: result.logs,
        },
      });
      return { verified: recorded.verified, issues: recorded.issues, status: recorded.status };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown server verification error.";
      return {
        verified: false,
        issues: [`Independent server verification is unavailable: ${detail}`],
        status: "unavailable",
      };
    }
  }

  async function runFund(chainJob: ChainJob) {
    if (mode === "rehearsal") {
      apply(syncFunded(desk, chainJob.id));
      return;
    }

    setBusy(true);
    try {
      const result = await liveFund({
        payer: chainJob.payer,
        jobId: chainJob.id,
        amountAtomic: chainJob.priceAtomic,
      });
      const recorded = await persistLive(result, chainJob);
      if (result.snapshot) setSnapshot(result.snapshot);

      if (recorded.verified) {
        apply(syncFunded(desk, chainJob.id));
        setBanner({
          ok: true,
          text: `Server independently verified ${result.instruction}. ${result.signature ?? ""} ${result.explorerUrl ?? ""}`.trim(),
        });
      } else {
        setBanner({
          ok: false,
          text: `${liveMessage(result)}${recorded.issues[0] ? ` · ${recorded.issues[0]}` : ""}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown funding error.";
      setBanner({ ok: false, text: `Funding could not be completed or independently verified. Check the transaction status before retrying. ${detail}` });
    } finally {
      setBusy(false);
    }
  }

  async function runRelease(chainJob: ChainJob, outputHash: string) {
    if (mode === "rehearsal") {
      apply(release(desk, chainJob.id, outputHash));
      return;
    }

    setBusy(true);
    try {
      const result = await liveRelease({
        merchant: chainJob.merchant,
        payer: chainJob.payer,
        jobId: chainJob.id,
        outputHash,
      });
      const recorded = await persistLive(result, chainJob);
      if (result.snapshot) setSnapshot(result.snapshot);

      if (recorded.verified) {
        apply(release(desk, chainJob.id, outputHash));
        setBanner({
          ok: true,
          text: `Server independently verified ${result.instruction}. ${result.signature ?? ""} ${result.explorerUrl ?? ""}`.trim(),
        });
      } else {
        setBanner({
          ok: false,
          text: `${liveMessage(result)}${recorded.issues[0] ? ` · ${recorded.issues[0]}` : ""}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown release error.";
      setBanner({ ok: false, text: `Release could not be completed or independently verified. Check the transaction status before retrying. ${detail}` });
    } finally {
      setBusy(false);
    }
  }

  async function runRefund(chainJob: ChainJob) {
    if (mode === "rehearsal") {
      apply(refund(desk, chainJob.id));
      return;
    }
    setBusy(true);
    try {
      const result = await liveRefund({
        merchant: chainJob.merchant,
        payer: chainJob.payer,
        jobId: chainJob.id,
      });
      const recorded = await persistLive(result, chainJob);
      if (result.snapshot) setSnapshot(result.snapshot);
      if (recorded.verified) {
        apply(refund(desk, chainJob.id));
        setBanner({
          ok: true,
          text: `Server independently verified ${result.instruction}. ${result.signature ?? ""} ${result.explorerUrl ?? ""}`.trim(),
        });
      } else {
        setBanner({
          ok: false,
          text: `${liveMessage(result)}${recorded.issues[0] ? ` · ${recorded.issues[0]}` : ""}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected refund error.";
      setBanner({ ok: false, text: `Refund failed: ${message}` });
    } finally {
      setBusy(false);
    }
  }

  async function postQuote() {
    if (quoteInFlight.current) return;

    const priceAtomic = parseUsdc(price);
    const nextTitle = title.trim();
    const nextBrief = brief.trim();

    if (priceAtomic == null) {
      setBanner({ ok: false, text: "Price must be between 0.01 and 1000 USDC, at most 6 decimals." });
      return;
    }
    if (!nextTitle || !nextBrief) {
      setBanner({ ok: false, text: "A quote needs a title and a brief." });
      return;
    }

    // A ref closes the same-tick double-submit window before React rerenders.
    quoteInFlight.current = true;
    setBusy(true);

    try {
      const id = hex(crypto.getRandomValues(new Uint8Array(16)));
      const specHash = await sha256Hex(
        specText({ sku, title: nextTitle, brief: nextBrief, priceAtomic }),
      );
      const expectedHash =
        fileHash ?? (await sha256Hex(
          deliverableText({ sku, title: nextTitle, brief: nextBrief }),
        ));

      const deadlineUnix =
        mode === "live"
          ? Math.floor(Date.now() / 1000) + 60 * 60
          : DEFAULT_DEADLINE;

      const quoted = initJob(desk, {
        id,
        sku,
        title: nextTitle,
        brief: nextBrief,
        priceAtomic,
        deadlineUnix,
        specHash,
        expectedHash,
        payer: mode === "live" ? payerAddr : DEMO_PAYER,
        merchant: mode === "live" ? merchantAddr : DEMO_MERCHANT,
      });

      if (mode !== "live" || !quoted.ok) {
        apply(quoted);
        return;
      }

      const result = await liveInitJob({
        merchant: merchantAddr,
        payer: payerAddr,
        jobId: id,
        amountAtomic: priceAtomic,
        specHash,
        expectedHash,
        deadlineUnix,
      });

      const recorded = await persistLive(result, quoted.desk.jobs[0]!);
      if (result.snapshot) setSnapshot(result.snapshot);

      if (recorded.verified) {
        apply(quoted);
        setBanner({
          ok: true,
          text: `Server independently verified ${result.instruction}. ${result.signature ?? ""} ${result.explorerUrl ?? ""}`.trim(),
        });
      } else {
        setBanner({
          ok: false,
          text: `${quoted.message} Chain: ${liveMessage(result)}${recorded.issues[0] ? ` · ${recorded.issues[0]}` : ""}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown initialization error.";
      setBanner({
        ok: false,
        text: `Quote could not be created or independently verified. Check transaction status before retrying. ${detail}`,
      });
    } finally {
      quoteInFlight.current = false;
      setBusy(false);
    }
  }

  async function runPass() {
    setBusy(true);
    setBanner(null);
    const still = {
      sku: "still" as const,
      title: "Kettle hero still",
      brief: "White seamless, 45 degree, soft shadow.",
    };
    const dub = {
      sku: "dub" as const,
      title: "EN/ES launch dub",
      brief: "15 seconds, warm read, no music bed.",
    };
    const stillBody = deliverableText(still);
    const dubBody = deliverableText(dub);
    const hashes = {
      stillSpec: await sha256Hex(specText({ ...still, priceAtomic: 100_000 })),
      stillExpected: await sha256Hex(stillBody),
      stillTamper: await sha256Hex(tamperedText(stillBody)),
      dubSpec: await sha256Hex(specText({ ...dub, priceAtomic: 100_000 })),
      dubExpected: await sha256Hex(dubBody),
      dubTamper: await sha256Hex(tamperedText(dubBody)),
    };
    const frames = judgeFrames(hashes);
    let cursor = emptyDesk();
    setDesk(cursor);
    setSelected(null);
    for (const frame of frames) {
      cursor = frame.desk;
      setDesk(cursor);
      if (frame.jobId) setSelected(frame.jobId);
      setBanner({ ok: frame.ok, text: frame.message });
      await wait(420);
    }
    setBusy(false);
  }

  const body = job ? deliverableText(job) : "";

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-tight">LedgerShot</p>
            <p className="text-xs text-muted">Devnet rehearsal · same four instructions as the program</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-xs ${drift === 0 ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>
              {drift === 0 ? "Books balance" : `Drift ${formatUsdc(drift)}`}
            </span>
            <Link to="/ops" className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm">
              Studio books
            </Link>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runPass()}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-medium text-bg disabled:opacity-50"
            >
              {busy ? "Running…" : "Run judge pass"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-4 lg:px-6">
        <section className="grid gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Pay for the file, not the invoice.</h1>
          <p className="max-w-3xl text-sm text-muted">
            Quote a product still or a dub sheet. USDC locks in a program vault and is released only when the
            deliverable hash matches the quote. Failed work is refunded on the same books.
          </p>
          <p className="max-w-3xl text-sm text-muted">
            静帧或配音单一经报价，USDC 锁进程序金库；交付哈希一致才放款，失败从同一本账退回。
          </p>
        </section>

        {banner ? (
          <p className={`rounded-lg px-3 py-2 text-sm ${banner.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"}`}>
            {banner.text}
          </p>
        ) : null}

        <LivePanel
          mode={mode}
          onMode={setMode}
          payer={payerAddr}
          merchant={merchantAddr}
          onPayer={setPayerAddr}
          onMerchant={setMerchantAddr}
          jobId={job?.id ?? null}
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          fileHash={fileHash}
          onFileHash={setFileHash}
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="grid content-start gap-4">
            <section className="grid gap-3 rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">New brief</h2>
              <div className="flex flex-wrap gap-2">
                <SkuButton active={sku === "still"} disabled={busy} onClick={() => setSku("still")}>
                  Product still
                </SkuButton>
                <SkuButton active={sku === "dub"} disabled={busy} onClick={() => setSku("dub")}>
                  Dub sheet
                </SkuButton>
              </div>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={80}
                  className="min-h-11 rounded-lg border border-line bg-bg px-3"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Brief</span>
                <textarea
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  maxLength={180}
                  rows={3}
                  className="rounded-lg border border-line bg-bg px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Price, USDC</span>
                <input
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  inputMode="decimal"
                  className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono"
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void postQuote()}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-accent px-3 text-sm text-accent disabled:opacity-50"
              >
                Post quote
              </button>
            </section>

            <section className="grid gap-2">
              <h2 className="text-sm font-semibold">Open jobs</h2>
              {desk.jobs.length === 0 ? (
                <p className="rounded-lg border border-line bg-surface px-4 py-6 text-sm text-muted">
                  No quotes yet. Post one, or run the judge pass: a clean still is paid, a tampered dub is refused and refunded.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {desk.jobs.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(item.id)}
                        className={`grid w-full min-h-11 gap-1 rounded-lg border px-3 py-2 text-left ${
                          item.id === selected ? "border-accent bg-surface-2" : "border-line bg-surface"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate font-medium">{item.title}</span>
                          <span className={tone(item.status)}>{STATUS_LABEL[item.status]}</span>
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {item.sku === "still" ? "Still" : "Dub"} · {formatUsdc(item.priceAtomic)} USDC · {short(item.id)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="grid content-start gap-4">
            <section className="grid gap-3 rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Books</h2>
              <div className="grid grid-cols-3 gap-2">
                <Book label="Payer clearing" amount={desk.books.payer} />
                <Book label="Escrow vault" amount={desk.books.vault} />
                <Book label="Merchant cash" amount={desk.books.merchant} />
              </div>
              <p className="text-xs text-muted">
                Opening {formatUsdc(2_000_000)} USDC. Gross settlement only — the studio desk splits the locked fee after release.
              </p>
            </section>

            <section className="grid gap-3 rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Proof</h2>
              {!job ? (
                <p className="text-sm text-muted">Select a job. The hash is sha256 of the canonical still or dub sheet.</p>
              ) : (
                <>
                  {job.sku === "still" ? (
                    <img
                      alt={job.title}
                      src={`data:image/svg+xml,${encodeURIComponent(body)}`}
                      className="w-full rounded-lg border border-line"
                    />
                  ) : (
                    <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs text-muted">{body}</pre>
                  )}
                  <Hash label="Expected" value={job.expectedHash} />
                  <Hash label="Spec" value={job.specHash} />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || job.status !== "quoted"}
                      onClick={() => void runFund(job)}
                      className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-medium text-bg disabled:opacity-40"
                    >
                      Fund escrow
                    </button>
                    <button
                      type="button"
                      disabled={busy || job.status !== "funded"}
                      onClick={() => void runRelease(job, job.expectedHash)}
                      className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                    >
                      Release match
                    </button>
                    <button
                      type="button"
                      disabled={busy || job.status !== "funded" || !tamperHash}
                      onClick={() => void runRelease(job, tamperHash)}
                      className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                    >
                      Release tampered
                    </button>
                    <button
                      type="button"
                      disabled={busy || job.status !== "funded"}
                      onClick={() => void runRefund(job)}
                      className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                    >
                      Refund
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="grid gap-2 rounded-lg border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Chain</h2>
              <p className="text-xs text-muted">
                {mode === "live"
                  ? "Live mode sends init_job, USDC transfer + sync_funded, release, and refund to the executable program. Simulation runs before the wallet popup. A hash mismatch fails closed and the vault does not move."
                  : "Rehearsal uses the same four checks as the program. Switch to live devnet to sign with Phantom, confirm the signature, and verify the vault token account."}
              </p>
              <p className="break-all font-mono text-xs">
                <a className="text-accent" href={EXPLORER} target="_blank" rel="noreferrer">
                  {PROGRAM_ID}
                </a>
              </p>
              <p className="break-all font-mono text-xs text-muted">
                USDC{" "}
                <a className="text-fg" href={MINT_EXPLORER} target="_blank" rel="noreferrer">
                  {USDC_MINT}
                </a>
              </p>
              <p className="break-all font-mono text-xs text-muted">Payer {DEMO_PAYER}</p>
              <p className="break-all font-mono text-xs text-muted">Merchant {DEMO_MERCHANT}</p>
              <ol className="grid gap-1 text-xs text-muted">
                <li>1. init_job — merchant signs, stores both hashes, opens the vault ATA</li>
                <li>2. Transfer USDC into the vault, then sync_funded — payer signs</li>
                <li>3. release(output_hash) — merchant signs, hash must equal expected</li>
                <li>4. refund — merchant signs early, or anyone after the deadline</li>
              </ol>
              {desk.log.length === 0 ? (
                <p className="text-xs text-muted">Instruction log is empty.</p>
              ) : (
                <ul className="grid gap-1">
                  {desk.log.map((line, index) => (
                    <li key={`${line.ix}-${index}`} className={`font-mono text-xs ${line.ok ? "text-fg" : "text-danger"}`}>
                      {line.ix} · {line.code}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function judgeFrames(hashes: {
  stillSpec: string;
  stillExpected: string;
  dubSpec: string;
  dubExpected: string;
  dubTamper: string;
}) {
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
  const frames: { desk: Desk; ok: boolean; message: string; jobId?: string }[] = [];
  let cursor = emptyDesk();
  const steps = [
    () => initJob(cursor, still),
    () => syncFunded(cursor, JUDGE_STILL_ID),
    () => release(cursor, JUDGE_STILL_ID, hashes.stillExpected),
    () => initJob(cursor, dub),
    () => syncFunded(cursor, JUDGE_DUB_ID),
    () => release(cursor, JUDGE_DUB_ID, hashes.dubTamper),
    () => refund(cursor, JUDGE_DUB_ID),
  ];
  for (const step of steps) {
    const result = step();
    cursor = result.desk;
    frames.push(result);
  }
  return frames;
}

function Book({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg p-2">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className="font-mono text-sm">{formatUsdc(amount)}</p>
    </div>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-all font-mono text-xs text-muted">
      {label} <span className="text-fg">{value}</span>
    </p>
  );
}

function SkuButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm ${
        active ? "bg-surface-2 text-fg" : "border border-line text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function tone(status: Status): string {
  if (status === "released") return "text-ok";
  if (status === "refunded") return "text-muted";
  if (status === "quoted") return "text-accent";
  return "text-fg";
}

function short(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveMessage(result: LiveResult): string {
  if (result.explorerUrl) return `${result.message} ${result.explorerUrl}`;
  return result.message;
}
