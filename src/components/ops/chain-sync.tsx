import { useEffect, useState } from "react";
import { formatUsdc } from "@/lib/ledger/format.ts";
import { explorerAddress } from "@/lib/chain/onchain.ts";
import {
  getChainHead,
  inspectOnchainJob,
  listChainTx,
  type ChainTxRow,
} from "@/lib/chain/observe-fn.ts";
import type { ChainSnapshot } from "@/lib/chain/rpc.ts";
import { DEMO_PAYER, PROGRAM_ID } from "@/lib/chain/escrow.ts";

export function ChainSync() {
  const [payer, setPayer] = useState(DEMO_PAYER);
  const [jobId, setJobId] = useState("");
  const [head, setHead] = useState<{ ok: boolean; slot: number; message?: string } | null>(null);
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null);
  const [rows, setRows] = useState<ChainTxRow[]>([]);
  const [txError, setTxError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadTx() {
    try {
      const listed = await listChainTx();
      if (!listed.ok) {
        setRows([]);
        setTxError(listed.message);
        return;
      }
      setRows(listed.rows);
      setTxError(null);
    } catch (error) {
      setRows([]);
      setTxError(error instanceof Error ? error.message : "Could not load transaction records.");
    }
  }

  useEffect(() => {
    void getChainHead()
      .then((value) =>
        setHead({ ok: value.ok, slot: value.slot, message: "message" in value ? value.message : undefined }),
      )
      .catch((error: unknown) => {
        setHead({
          ok: false,
          slot: 0,
          message: error instanceof Error ? error.message : "RPC unreachable",
        });
      });
    void loadTx();
  }, []);

  async function inspect() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await inspectOnchainJob({
        data: { payer, jobId: jobId.trim() || undefined },
      });
      if (!result.ok || !result.snapshot) {
        setMessage(result.ok ? "No snapshot" : result.message);
        setSnapshot(null);
        return;
      }
      setSnapshot(result.snapshot);
    } catch (error) {
      setSnapshot(null);
      setMessage(error instanceof Error ? error.message : "On-chain inspection failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Live chain</h2>
          <span
            className={`rounded-full px-2 py-1 text-xs ${
              head == null ? "bg-surface-2 text-muted" : head.ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"
            }`}
          >
            {head == null ? "Checking RPC" : head.ok ? `devnet slot ${head.slot}` : head.message ?? "RPC unreachable"}
          </span>
        </div>
        <p className="text-sm text-muted">
          Read-only inspect of the PDA, vault, and signatures the server verified from RPC.
          Signing stays on the escrow desk. This page does not trust a client-sent status.
        </p>
        <p className="break-all font-mono text-xs text-muted">
          Program{" "}
          <a className="text-accent" href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer">
            {PROGRAM_ID}
          </a>
        </p>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
          <input
            className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono text-xs"
            value={payer}
            onChange={(event) => setPayer(event.target.value.trim())}
            placeholder="Payer pubkey"
            spellCheck={false}
          />
          <input
            className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono text-xs"
            value={jobId}
            onChange={(event) => setJobId(event.target.value.trim().toLowerCase())}
            placeholder="16-byte job id hex"
            spellCheck={false}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void inspect()}
            className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg disabled:opacity-50"
          >
            {busy ? "Reading…" : "Inspect PDA"}
          </button>
        </div>
        {message ? <p className="text-sm text-danger">{message}</p> : null}
        {snapshot ? (
          <dl className="grid grid-cols-2 gap-2 text-sm lg:grid-cols-4">
            <Stat label="Job" value={snapshot.job?.status ?? "missing"} />
            <Stat label="Vault" value={formatUsdc(snapshot.vault.atomic)} />
            <Stat label="Payer USDC" value={formatUsdc(snapshot.payerUsdc.atomic)} />
            <Stat label="Merchant USDC" value={formatUsdc(snapshot.merchantUsdc.atomic)} />
            {snapshot.job ? (
              <>
                <Stat label="Quoted" value={formatUsdc(snapshot.job.amountAtomic)} />
                <Stat label="PDA" value={short(snapshot.job.address)} href={explorerAddress(snapshot.job.address)} />
                <Stat label="Expected" value={short(snapshot.job.expectedHash)} />
                <Stat label="Output" value={snapshot.job.outputHash.replace(/0/g, "") ? short(snapshot.job.outputHash) : "empty"} />
              </>
            ) : null}
          </dl>
        ) : null}
        {snapshot?.drift?.length ? (
          <ul className="grid gap-1">
            {snapshot.drift.map((item) => (
              <li key={item} className="text-sm text-danger">
                {item}
              </li>
            ))}
          </ul>
        ) : snapshot?.job ? (
          <p className="text-sm text-ok">Vault, mint, and job status agree.</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">Verified signatures</h2>
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => void loadTx()}>
            Reload
          </button>
        </div>
        {txError ? (
          <p className="px-4 py-6 text-sm text-danger">Could not load transaction records: {txError}</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No recorded transactions yet. Send one from the escrow desk in live mode.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id} className="grid gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs text-accent">{row.instruction}</p>
                  <span className={`text-xs ${row.chain_ok ? "text-ok" : row.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {row.chain_ok ? "verified" : row.status}
                    {row.slot ? ` · slot ${row.slot}` : ""}
                  </span>
                </div>
                <a className="break-all font-mono text-xs text-fg" href={row.explorer_url} target="_blank" rel="noreferrer">
                  {row.tx_signature}
                </a>
                <p className="font-mono text-xs text-muted">
                  program {row.program_ok ? "ok" : "no"} · mint {row.mint_ok ? "ok" : "no"} · amount {row.amount_ok ? "ok" : "no"}
                </p>
                {row.verify_issues ? <p className="text-xs text-danger">{row.verify_issues}</p> : null}
                {row.error_code ? <p className="text-xs text-danger">{row.error_code}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-lg bg-bg px-2 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-mono text-xs">
        {href ? (
          <a className="text-accent" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function short(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
