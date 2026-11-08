import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { deliverableText, sha256Hex, specText, tamperedText } from "@/lib/chain/deliverable";
import { gateLiveStep, type BannerTone } from "@/lib/chain/desk-gate";
import { loadStoredDesk, saveStoredDesk } from "@/lib/chain/desk-store";
import {
  DEMO_MERCHANT,
  DEMO_PAYER,
  DEFAULT_DEADLINE,
  JUDGE_DUB_ID,
  JUDGE_STILL_ID,
  PROGRAM_ID,
  USDC_MINT,
  adoptChainJob,
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
import { explorerTx } from "@/lib/chain/onchain";
import { liveFund, liveInitJob, liveRefund, liveRelease, type LiveResult } from "@/lib/chain/live.ts";
import { confirmAndRecordTx } from "@/lib/chain/observe-fn.ts";
import { chainJobFromAccount, loadJobById, loadJobBySignature, loadRecentJobs } from "@/lib/chain/resume";
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

type Banner = { tone: BannerTone; text: string };

export function JudgeDesk() {
  const [desk, setDesk] = useState<Desk>(() => emptyDesk());
  const [selected, setSelected] = useState<string | null>(null);
  const [sku, setSku] = useState<Sku>("still");
  const [title, setTitle] = useState("Kettle hero still");
  const [brief, setBrief] = useState("White seamless, 45 degree, soft shadow.");
  const [price, setPrice] = useState("0.10");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const quoteInFlight = useRef(false);
  const [tamperHash, setTamperHash] = useState("");
  const [mode, setMode] = useState<DeskMode>("rehearsal");
  const [payerAddr, setPayerAddr] = useState(DEMO_PAYER);
  const [merchantAddr, setMerchantAddr] = useState(DEMO_MERCHANT);
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [booted, setBooted] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [resumeBusy, setResumeBusy] = useState(false);

  const job = desk.jobs.find((item) => item.id === selected) ?? null;
  const drift = booksDrift(desk);

  useEffect(() => {
    const saved = loadStoredDesk();
    if (saved) {
      setDesk(saved.desk);
      setSelected(saved.selected);
      setMode(saved.mode);
      if (saved.payer) setPayerAddr(saved.payer);
      if (saved.merchant) setMerchantAddr(saved.merchant);
      setProofs(saved.proofs);
    }
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted) return;
    saveStoredDesk({
      mode,
      payer: payerAddr,
      merchant: merchantAddr,
      desk,
      selected,
      proofs,
    });
  }, [booted, mode, payerAddr, merchantAddr, desk, selected, proofs]);

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
    setBanner({ tone: result.ok ? "ok" : "danger", text: result.message });
    if (result.jobId) setSelected(result.jobId);
  }

  function finishLive(
    local: { desk: Desk; ok: boolean; message: string; jobId?: string },
    result: LiveResult,
    recorded: { verified: boolean; issues: string[]; status: string },
    chainText: string,
  ) {
    if (result.snapshot) setSnapshot(result.snapshot);
    const gate = gateLiveStep({
      chainOk: result.ok,
      chainText,
      recorded,
      instruction: result.instruction,
      signature: result.signature,
      explorerUrl: result.explorerUrl,
    });
    if (gate.applyLocal && local.ok) {
      setDesk(local.desk);
      if (local.jobId) setSelected(local.jobId);
      if (result.signature && local.jobId) {
        setProofs((prev) => ({ ...prev, [local.jobId!]: result.signature! }));
      }
    }
    setBanner({ tone: gate.tone, text: gate.text });
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
      finishLive(
        syncFunded(desk, chainJob.id, { liveMirror: true }),
        result,
        recorded,
        liveMessage(result),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown funding error.";
      setBanner({ tone: "danger", text: `Funding could not be completed or independently verified. Check the transaction status before retrying. ${detail}` });
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
      finishLive(release(desk, chainJob.id, outputHash), result, recorded, liveMessage(result));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown release error.";
      setBanner({ tone: "danger", text: `Release could not be completed or independently verified. Check the transaction status before retrying. ${detail}` });
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
      finishLive(refund(desk, chainJob.id), result, recorded, liveMessage(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected refund error.";
      setBanner({ tone: "danger", text: `Refund failed: ${message}` });
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
      setBanner({ tone: "danger", text: "Price must be between 0.01 and 1000 USDC, at most 6 decimals." });
      return;
    }
    if (!nextTitle || !nextBrief) {
      setBanner({ tone: "danger", text: "A quote needs a title and a brief." });
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
          ? Math.floor(Date.now() / 1000) + 24 * 60 * 60
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
      finishLive(quoted, result, recorded, `${quoted.message} ${liveMessage(result)}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown initialization error.";
      setBanner({
        tone: "danger",
        text: `Quote could not be created or independently verified. Check transaction status before retrying. ${detail}`,
      });
    } finally {
      quoteInFlight.current = false;
      setBusy(false);
    }
  }

  async function openRecovered(chain: Awaited<ReturnType<typeof loadJobById>>) {
    const local = desk.jobs.find((item) => item.id === chain.jobId);
    const chainJob = chainJobFromAccount(
      chain,
      local ? { sku: local.sku, title: local.title, brief: local.brief } : undefined,
    );
    const adopted = adoptChainJob(desk, chainJob);
    if (!adopted.ok) {
      setBanner({ tone: "danger", text: adopted.message });
      return;
    }
    setDesk(adopted.desk);
    if (adopted.jobId) setSelected(adopted.jobId);
    setPayerAddr(chainJob.payer);
    setMerchantAddr(chainJob.merchant);
    setMode("live");
    setBanner({
      tone: chainJob.status === "quoted" ? "warn" : "ok",
      text: `${adopted.message} Payer and merchant were filled from the account. Proof is on the right.`,
    });
  }

  async function resumeInput() {
    const text = resumeText.trim();
    if (!text) {
      setBanner({ tone: "danger", text: "Paste a 32-hex job id or the init_job signature from Phantom." });
      return;
    }
    setResumeBusy(true);
    try {
      if (/^[0-9a-fA-F]{32}$/.test(text)) {
        if (!payerAddr) throw new Error("Set the payer address first. The Job PDA is derived from payer plus job id.");
        await openRecovered(await loadJobById(payerAddr, text.toLowerCase()));
      } else {
        await openRecovered(await loadJobBySignature(text));
      }
    } catch (error) {
      setBanner({ tone: "danger", text: error instanceof Error ? error.message : "Could not open that job." });
    } finally {
      setResumeBusy(false);
    }
  }

  async function scanMerchant() {
    if (!merchantAddr) {
      setBanner({ tone: "danger", text: "Set the merchant address, or connect Phantom and use that wallet." });
      return;
    }
    setResumeBusy(true);
    try {
      const jobs = await loadRecentJobs(merchantAddr);
      if (jobs.length === 0) {
        setBanner({ tone: "warn", text: "No recent init_job was found for this merchant on devnet." });
        return;
      }
      await openRecovered(jobs[0]!);
    } catch (error) {
      setBanner({ tone: "danger", text: error instanceof Error ? error.message : "Wallet scan failed." });
    } finally {
      setResumeBusy(false);
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
      setBanner({ tone: frame.ok ? "ok" : "danger", text: frame.message });
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
            <p className="text-xs text-muted">
              {mode === "live" ? "Live devnet · wallet signed" : "Rehearsal · same four instructions"}
            </p>
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
          <p
            className={`rounded-lg px-3 py-2 text-sm ${
              banner.tone === "ok"
                ? "bg-ok/10 text-ok"
                : banner.tone === "warn"
                  ? "bg-accent/15 text-accent"
                  : "bg-danger/10 text-danger"
            }`}
          >
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
                  No quotes in this browser yet. Post one, or open a devnet job that already has a PDA.
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
              {mode === "live" || desk.jobs.length === 0 ? (
                <div className="grid gap-2 rounded-lg border border-line bg-surface p-3">
                  <p className="text-sm font-medium">Already on devnet</p>
                  <p className="text-xs text-muted">
                    Paste the init_job signature from Phantom, or the 32-hex job id. This selects the job so Fund escrow shows in Proof. It does not send another transaction.
                  </p>
                  <input
                    value={resumeText}
                    onChange={(event) => setResumeText(event.target.value.trim())}
                    placeholder="Signature or job id"
                    spellCheck={false}
                    className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={resumeBusy}
                      onClick={() => void resumeInput()}
                      className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-medium text-bg disabled:opacity-50"
                    >
                      {resumeBusy ? "Reading chain…" : "Open that job"}
                    </button>
                    <button
                      type="button"
                      disabled={resumeBusy || !merchantAddr}
                      onClick={() => void scanMerchant()}
                      className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm disabled:opacity-40"
                    >
                      Scan merchant
                    </button>
                  </div>
                </div>
              ) : null}
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
                  <p className="break-all font-mono text-xs text-muted">
                    Job <span className="text-fg">{job.id}</span>
                  </p>
                  {proofs[job.id] ? (
                    <p className="break-all font-mono text-xs text-muted">
                      Last tx{" "}
                      <a className="text-accent" href={explorerTx(proofs[job.id]!)} target="_blank" rel="noreferrer">
                        {short(proofs[job.id]!, 6, 6)}
                      </a>
                    </p>
                  ) : null}
                  {job.status === "quoted" ? (
                    <p className="rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent">
                      Next: Fund escrow. init_job only opens the vault, so 0 USDC is correct until the payer signs the transfer.
                    </p>
                  ) : null}
                  {job.status === "funded" ? (
                    <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
                      Next: Release match pays the merchant when the hash matches. Release tampered must fail closed. Refund returns the vault to the payer.
                    </p>
                  ) : null}
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
