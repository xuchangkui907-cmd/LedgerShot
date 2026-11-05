import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatUsdc, PROGRAM_ID } from "@/lib/chain/escrow.ts";
import { explorerAddress } from "@/lib/chain/onchain.ts";
import { liveAddresses } from "@/lib/chain/live.ts";
import { getChainHead, inspectOnchainJob } from "@/lib/chain/observe-fn.ts";
import type { ChainSnapshot } from "@/lib/chain/rpc.ts";
import { usePhantom } from "./use-phantom.ts";

export type DeskMode = "rehearsal" | "live";

type Props = {
  mode: DeskMode;
  onMode: (mode: DeskMode) => void;
  payer: string;
  merchant: string;
  onPayer: (value: string) => void;
  onMerchant: (value: string) => void;
  jobId: string | null;
  snapshot: ChainSnapshot | null;
  onSnapshot: (snapshot: ChainSnapshot | null) => void;
  fileHash: string | null;
  onFileHash: (hash: string | null) => void;
};

export function LivePanel({
  mode,
  onMode,
  payer,
  merchant,
  onPayer,
  onMerchant,
  jobId,
  snapshot,
  onSnapshot,
  fileHash,
  onFileHash,
}: Props) {
  const wallet = usePhantom();
  const [rpc, setRpc] = useState<{ ok: boolean; slot: number; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wallet.pubkey && !payer) onPayer(wallet.pubkey);
    if (wallet.pubkey && !merchant) onMerchant(wallet.pubkey);
  }, [wallet.pubkey, payer, merchant, onPayer, onMerchant]);

  useEffect(() => {
    let cancel = false;
    void getChainHead()
      .then((head) => {
        if (!cancel) setRpc({ ok: head.ok, slot: head.slot, message: "message" in head ? head.message : undefined });
      })
      .catch((error: unknown) => {
        if (!cancel) {
          setRpc({
            ok: false,
            slot: 0,
            message: error instanceof Error ? error.message : "RPC unreachable",
          });
        }
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function refresh() {
    if (!payer) return;
    setBusy(true);
    try {
      const result = await inspectOnchainJob({
        data: { payer, merchant: merchant || payer, jobId: jobId ?? undefined },
      });
      if (result.ok) onSnapshot(result.snapshot);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (mode !== "live") return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, payer, merchant, jobId]);

  let addrs: { job: string; vault: string } | null = null;
  try {
    if (jobId && payer) addrs = liveAddresses(payer, jobId);
  } catch {
    addrs = null;
  }

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Settlement rail</h2>
        <div className="ml-auto flex flex-wrap gap-2">
          <ModeChip active={mode === "rehearsal"} onClick={() => onMode("rehearsal")}>
            Rehearsal
          </ModeChip>
          <ModeChip active={mode === "live"} onClick={() => onMode("live")}>
            Live devnet
          </ModeChip>
        </div>
      </div>
      <p className="text-xs text-muted">
        Rehearsal is local and for judges. Live asks Phantom to sign, then the server
        fetches the signature from RPC and checks program, mint, accounts, and amount
        before the desk books move. Source is v1.2 (USDC mint pinned, exact vault). Redeploy
        before a live judge transaction if the executable is still older.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-1 text-xs ${
            rpc == null ? "bg-surface-2 text-muted" : rpc.ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"
          }`}
        >
          {rpc == null ? "Checking RPC" : rpc.ok ? `RPC slot ${rpc.slot}` : rpc.message ?? "RPC unreachable"}
        </span>
        {wallet.pubkey ? (
          <span className="rounded-full bg-surface-2 px-2 py-1 font-mono text-xs">{short(wallet.pubkey)}</span>
        ) : (
          <span className="text-xs text-muted">{wallet.available ? "Phantom detected" : "Phantom not found"}</span>
        )}
        {wallet.pubkey ? (
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => void wallet.disconnect()}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg"
            onClick={() => void wallet.connect()}
          >
            Connect Phantom
          </button>
        )}
        <button type="button" disabled={busy || !payer} className="min-h-11 rounded-lg border border-line px-3 text-sm disabled:opacity-40" onClick={() => void refresh()}>
          {busy ? "Reading…" : "Refresh chain"}
        </button>
      </div>
      {wallet.error ? <p className="text-sm text-danger">{wallet.error}</p> : null}
      {mode === "live" ? (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Payer</span>
              <input
                value={payer}
                onChange={(event) => onPayer(event.target.value.trim())}
                className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono text-xs"
                spellCheck={false}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Merchant</span>
              <input
                value={merchant}
                onChange={(event) => onMerchant(event.target.value.trim())}
                className="min-h-11 rounded-lg border border-line bg-bg px-3 font-mono text-xs"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Mini label="Payer SOL" value={lamports(snapshot?.payerSolLamports)} />
            <Mini label="Payer USDC" value={formatUsdc(snapshot?.payerUsdc.atomic ?? 0)} />
            <Mini label="Vault USDC" value={formatUsdc(snapshot?.vault.atomic ?? 0)} />
            <Mini label="Merchant USDC" value={formatUsdc(snapshot?.merchantUsdc.atomic ?? 0)} />
          </div>
          <label className="grid gap-1 text-sm">
            <span className="text-muted">Deliverable file hash (optional)</span>
            <input
              type="file"
              className="min-h-11 rounded-lg border border-line bg-bg px-3 py-2 text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  onFileHash(null);
                  return;
                }
                void file.arrayBuffer().then(async (buffer) => {
                  const { sha256Bytes } = await import("@/lib/chain/deliverable.ts");
                  onFileHash(await sha256Bytes(buffer));
                });
              }}
            />
            {fileHash ? <span className="break-all font-mono text-xs text-muted">sha256 {fileHash}</span> : null}
          </label>
          {snapshot?.drift?.length ? (
            <ul className="grid gap-1">
              {snapshot.drift.map((item) => (
                <li key={item} className="text-sm text-danger">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          {snapshot?.job ? (
            <p className="font-mono text-xs text-muted">
              On-chain {snapshot.job.status} · PDA{" "}
              <a className="text-accent" href={explorerAddress(snapshot.job.address)} target="_blank" rel="noreferrer">
                {short(snapshot.job.address)}
              </a>
            </p>
          ) : addrs ? (
            <p className="font-mono text-xs text-muted">
              Expected PDA{" "}
              <a className="text-accent" href={explorerAddress(addrs.job)} target="_blank" rel="noreferrer">
                {short(addrs.job)}
              </a>
            </p>
          ) : null}
          <p className="font-mono text-xs text-muted">
            Program{" "}
            <a className="text-accent" href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer">
              {PROGRAM_ID}
            </a>
          </p>
        </>
      ) : (
        <p className="text-xs text-muted">
          Judge pass stays on the rehearsal books. Switch to live only when the connected wallet
          holds devnet SOL and Circle USDC. Studio books stay on <Link to="/ops">/ops</Link>.
        </p>
      )}
    </section>
  );
}

function ModeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm ${
        active ? "bg-surface-2 text-fg" : "border border-line text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg p-2">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className="font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

function short(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function lamports(value: number | undefined): string {
  if (value == null) return "—";
  return (value / 1_000_000_000).toFixed(4);
}
