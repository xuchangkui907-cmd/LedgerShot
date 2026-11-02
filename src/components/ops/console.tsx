import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Activity,
  BookOpen,
  Gauge,
  LifeBuoy,
  ScrollText,
  Store,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import handbook from "../../../docs/OPS-RUNBOOK.md?raw";
import { ERROR_CATALOG, type ErrorCode } from "@/lib/ledger/failure";
import {
  MERCHANT_LABEL,
  RISK_LABEL,
  STATE_LABEL,
  formatPct,
  formatTime,
  formatUsdc,
  stateTone,
} from "@/lib/ledger/format";
import { audit, hourlySeries, slo } from "@/lib/ledger/observe";
import { DEMO_NOW, buildDemo } from "@/lib/ledger/seed";
import {
  apply,
  skuLabel,
  type Command,
  type Job,
  type JobState,
  type Merchant,
  type World,
} from "@/lib/ledger/service";
import { RunbookView } from "./runbook-view";

type Tab = "overview" | "merchants" | "ledger" | "failures" | "observe" | "runbook";

const TABS: { id: Tab; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "总览", icon: Gauge },
  { id: "merchants", label: "商户", icon: Store },
  { id: "ledger", label: "任务账本", icon: ScrollText },
  { id: "failures", label: "失败队列", icon: LifeBuoy },
  { id: "observe", label: "可观测", icon: Activity },
  { id: "runbook", label: "上线手册", icon: BookOpen },
];

const ACTOR = "值班-预览";

export function OpsConsole() {
  const [world, setWorld] = useState<World>(() => buildDemo(DEMO_NOW));
  const [now, setNow] = useState(DEMO_NOW);
  const [tab, setTab] = useState<Tab>("overview");
  const [merchantId, setMerchantId] = useState("m_kuajing");
  const [jobId, setJobId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [tamper, setTamper] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<JobState | "all" | "holding">("all");

  const shadow = useMemo(() => {
    if (!tamper) return world;
    const next = structuredClone(world);
    if (next.merchants[0]) next.merchants[0].creditMicro += 1;
    return next;
  }, [world, tamper]);
  const violations = useMemo(() => audit(shadow), [shadow]);
  const report = useMemo(() => slo(world), [world]);
  const series = useMemo(() => hourlySeries(world, now), [world, now]);
  const merchant = world.merchants.find((item) => item.id === merchantId) ?? world.merchants[0];
  const selectedJob = world.jobs.find((item) => item.id === jobId) ?? null;

  function act(command: Command) {
    const result = apply(world, command, now);
    setWorld(result.world);
    setBanner({
      ok: result.ok,
      text: result.replay ? `幂等回放 · ${result.message}` : result.message,
    });
    if (result.jobId) setJobId(result.jobId);
    return result;
  }

  function place(form: { merchantId: string; sku: Job["sku"]; title: string; usdc: string }) {
    const quoteMicro = Math.round(Number(form.usdc) * 1_000_000);
    if (!Number.isFinite(quoteMicro) || quoteMicro < 10_000) {
      setBanner({ ok: false, text: "金额至少 0.01 USDC，且必须是数字" });
      return;
    }
    const stamp = freshKey("ord");
    const quoted = apply(world, {
      type: "quote",
      merchantId: form.merchantId,
      sku: form.sku,
      title: form.title.trim() || "未命名任务",
      quoteMicro,
      idempotencyKey: `${stamp}-q`,
    }, now);
    if (!quoted.ok || !quoted.jobId) {
      setWorld(quoted.world);
      setBanner({ ok: false, text: quoted.message });
      return;
    }
    const reserved = apply(quoted.world, {
      type: "reserve",
      jobId: quoted.jobId,
      idempotencyKey: `${stamp}-r`,
    }, now);
    if (!reserved.ok) {
      setWorld(reserved.world);
      setJobId(quoted.jobId);
      setTab("ledger");
      setBanner({ ok: false, text: reserved.message });
      return;
    }
    const dispatched = apply(reserved.world, {
      type: "dispatch",
      jobId: quoted.jobId,
      idempotencyKey: `${stamp}-d`,
    }, now);
    setWorld(dispatched.world);
    setJobId(quoted.jobId);
    setTab("ledger");
    setBanner({ ok: dispatched.ok, text: dispatched.ok ? "已冻结并派发" : dispatched.message });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 grid-rows-3 gap-1 rounded-md bg-bg p-2" aria-hidden="true">
              <span className="rounded-sm bg-accent" />
              <span className="w-3/4 rounded-sm bg-fg" />
              <span className="w-1/2 rounded-sm bg-ok" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold tracking-tight">LedgerShot studio books</p>
              <p className="text-xs text-muted">Fee lock, retries, dead letter · rehearsal ledger</p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Link to="/" className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm">
              Escrow desk
            </Link>
            <span className={`rounded-full px-2 py-1 text-xs ${violations.length ? "bg-danger/15 text-danger" : "bg-ok/15 text-ok"}`}>
              {violations.length ? `账差 ${violations.length}` : "账实相符"}
            </span>
            <span className="font-mono text-xs text-muted">{formatTime(now)} CST</span>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-line px-3 text-sm"
              onClick={() => setNow((value) => value + 30 * 60_000)}
            >
              推进 30 分钟
            </button>
          </div>
        </div>
      </header>

      {banner ? (
        <p className={`px-4 py-2 text-sm lg:px-6 ${banner.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"}`}>
          {banner.text}
        </p>
      ) : null}

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:flex-col lg:gap-1 lg:overflow-visible lg:border-b-0 lg:border-r lg:px-3 lg:py-4">
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm ${active ? "bg-surface-2 text-fg" : "text-muted"}`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <main className="min-w-0 px-4 py-4 lg:px-6 lg:py-6">
          {tab === "overview" ? (
            <Overview
              world={world}
              report={report}
              series={series}
              violations={violations}
              tamper={tamper}
              onTamper={() => setTamper((value) => !value)}
              onOpenJob={(id) => {
                setJobId(id);
                setTab("failures");
              }}
              onIncident={(incidentId, action) =>
                act({ type: "incident", action, incidentId, actor: ACTOR, reason: "演练处置" })
              }
            />
          ) : null}
          {tab === "merchants" && merchant ? (
            <Merchants
              world={world}
              selected={merchant}
              onSelect={setMerchantId}
              onAct={act}
            />
          ) : null}
          {tab === "ledger" ? (
            <Ledger
              world={world}
              query={query}
              stateFilter={stateFilter}
              selected={selectedJob}
              onQuery={setQuery}
              onFilter={setStateFilter}
              onSelect={setJobId}
              onAct={act}
              onPlace={place}
            />
          ) : null}
          {tab === "failures" ? (
            <Failures world={world} now={now} onSelect={(id) => { setJobId(id); }} selected={selectedJob} onAct={act} onTick={() => act({ type: "tick" })} />
          ) : null}
          {tab === "observe" ? <Observe world={world} report={report} violations={violations} /> : null}
          {tab === "runbook" ? <RunbookView source={handbook} /> : null}
        </main>
      </div>
    </div>
  );
}

function Overview({
  world,
  report,
  series,
  violations,
  tamper,
  onTamper,
  onOpenJob,
  onIncident,
}: {
  world: World;
  report: ReturnType<typeof slo>;
  series: ReturnType<typeof hourlySeries>;
  violations: ReturnType<typeof audit>;
  tamper: boolean;
  onTamper: () => void;
  onOpenJob: (id: string) => void;
  onIncident: (id: string, action: "mitigate" | "close") => void;
}) {
  const openIncidents = world.incidents.filter((incident) => incident.status !== "closed");
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="冻结预授权" value={formatUsdc(report.heldMicro)} />
        <Kpi label="平台收入" value={formatUsdc(report.revenueMicro)} />
        <Kpi label="终态成功率" value={formatPct(report.rate)} hint={`目标 ${formatPct(report.target)}`} tone={report.rate < report.target ? "text-danger" : "text-ok"} />
        <Kpi label="错误预算剩余" value={formatPct(report.errorBudgetRemaining)} hint={`死信 ${report.deadLetters}`} tone={report.errorBudgetRemaining < 0.2 ? "text-danger" : "text-ok"} />
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium">近 12 小时终态</h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--color-muted)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} stroke="var(--color-muted)" fontSize={12} width={28} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "var(--color-surface-2)" }}
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-line)",
                    borderRadius: 8,
                    color: "var(--color-fg)",
                  }}
                />
                <Bar dataKey="ok" name="成功或已退款" stackId="s" fill="var(--color-ok)" />
                <Bar dataKey="bad" name="死信或核销" stackId="s" fill="var(--color-danger)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium">未关闭事件</h2>
          <div className="flex flex-col gap-3">
            {openIncidents.length === 0 ? <p className="text-sm text-muted">没有打开的事件。</p> : null}
            {openIncidents.map((incident) => (
              <div key={incident.id} className="rounded-lg border border-line bg-bg p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{incident.title}</p>
                  <span className={incident.severity === "sev2" ? "text-xs text-danger" : "text-xs text-accent"}>
                    {incident.severity.toUpperCase()} · {incident.status === "open" ? "打开" : "已缓解"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">{incident.summary}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onIncident(incident.id, "mitigate")}>
                    缓解
                  </button>
                  <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onIncident(incident.id, "close")}>
                    关闭
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">对账</h2>
            <p className="text-sm text-muted">期初 = 可用 + 冻结 + 平台收入 + 渲染池应付 + 损耗</p>
          </div>
          <button type="button" className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg" onClick={onTamper}>
            {tamper ? "撤回演练账差" : "注入 1 micro 账差"}
          </button>
        </div>
        {violations.length === 0 ? (
          <p className="mt-3 text-sm text-ok">0 条账差。在途冻结与任务报价一致，已结算拆分与锁定费率一致。</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {violations.map((item) => (
              <li key={item.message} className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {item.code} · {item.message}
              </li>
            ))}
          </ul>
        )}
        {tamper ? <p className="mt-2 text-xs text-muted">这是影子副本，正式账本没有被改写。</p> : null}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">待处理死信</h2>
        <JobList
          jobs={world.jobs.filter((job) => job.state === "dead_letter")}
          merchants={world.merchants}
          onSelect={onOpenJob}
          activeId={null}
        />
      </section>
    </div>
  );
}

function Merchants({
  world,
  selected,
  onSelect,
  onAct,
}: {
  world: World;
  selected: Merchant;
  onSelect: (id: string) => void;
  onAct: (command: Command) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-2">
        {world.merchants.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`rounded-xl border p-3 text-left ${item.id === selected.id ? "border-accent bg-surface" : "border-line bg-surface"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{item.name}</p>
                <p className="text-sm text-muted">{item.desk} · {item.region} · {item.pool}</p>
              </div>
              <span className={item.status === "active" ? "text-xs text-ok" : "text-xs text-danger"}>
                {MERCHANT_LABEL[item.status]}
              </span>
            </div>
            <p className="mt-2 font-mono text-sm">可用 {formatUsdc(item.creditMicro)}</p>
            <p className="font-mono text-xs text-muted">冻结 {formatUsdc(item.reservedMicro)} · 费率 {(item.feeBps / 100).toFixed(2)}%</p>
          </button>
        ))}
      </div>
      <aside className="rounded-xl border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold">{selected.name}</h2>
        <p className="text-sm text-muted">{RISK_LABEL[selected.risk]} · {selected.wallet}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <Metric label="可用" value={formatUsdc(selected.creditMicro)} />
          <Metric label="冻结" value={formatUsdc(selected.reservedMicro)} />
          <Metric label="平台收入" value={formatUsdc(selected.platformRevenueMicro)} />
          <Metric label="渲染池应付" value={formatUsdc(selected.supplierPayableMicro)} />
          <Metric label="损耗" value={formatUsdc(selected.platformLossMicro)} />
          <Metric label="期初" value={formatUsdc(selected.openingMicro)} />
        </dl>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "freeze", merchantId: selected.id, reason: "演练止付", actor: ACTOR, idempotencyKey: freshKey("freeze") })}>
            冻结
          </button>
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "unfreeze", merchantId: selected.id, reason: "演练解除", actor: ACTOR, idempotencyKey: freshKey("thaw") })}>
            解冻
          </button>
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "hold", merchantId: selected.id, reason: "演练暂停结算", actor: ACTOR, idempotencyKey: freshKey("hold") })}>
            暂停结算
          </button>
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "release_hold", merchantId: selected.id, reason: "演练恢复结算", actor: ACTOR, idempotencyKey: freshKey("release") })}>
            恢复结算
          </button>
        </div>
      </aside>
    </div>
  );
}

function Ledger({
  world,
  query,
  stateFilter,
  selected,
  onQuery,
  onFilter,
  onSelect,
  onAct,
  onPlace,
}: {
  world: World;
  query: string;
  stateFilter: JobState | "all" | "holding";
  selected: Job | null;
  onQuery: (value: string) => void;
  onFilter: (value: JobState | "all" | "holding") => void;
  onSelect: (id: string) => void;
  onAct: (command: Command) => void;
  onPlace: (form: { merchantId: string; sku: Job["sku"]; title: string; usdc: string }) => void;
}) {
  const [draft, setDraft] = useState({ merchantId: "m_hesheng", sku: "dub" as Job["sku"], title: "加急口播", usdc: "9.50" });
  const jobs = world.jobs.filter((job) => {
    const merchant = world.merchants.find((item) => item.id === job.merchantId);
    const hay = `${job.title} ${job.id} ${merchant?.name ?? ""}`.toLowerCase();
    if (query && !hay.includes(query.trim().toLowerCase())) return false;
    if (stateFilter === "all") return true;
    if (stateFilter === "holding") return job.state === "reserved" || job.state === "dispatched" || job.state === "dead_letter";
    return job.state === stateFilter;
  });

  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid gap-2 rounded-xl border border-line bg-surface p-4 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          onPlace(draft);
        }}
      >
        <label className="text-sm">
          <span className="mb-1 block text-muted">商户</span>
          <select
            className="min-h-11 w-full rounded-lg border border-line bg-bg px-2"
            value={draft.merchantId}
            onChange={(event) => setDraft({ ...draft, merchantId: event.target.value })}
          >
            {world.merchants.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">品类</span>
          <select
            className="min-h-11 w-full rounded-lg border border-line bg-bg px-2"
            value={draft.sku}
            onChange={(event) => setDraft({ ...draft, sku: event.target.value as Job["sku"] })}
          >
            <option value="dub">配音</option>
            <option value="still">静帧</option>
            <option value="short">短剧</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">标题</span>
          <input className="min-h-11 w-full rounded-lg border border-line bg-bg px-2" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">金额 USDC</span>
          <input className="min-h-11 w-full rounded-lg border border-line bg-bg px-2 font-mono" inputMode="decimal" value={draft.usdc} onChange={(event) => setDraft({ ...draft, usdc: event.target.value })} />
        </label>
        <button type="submit" className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg md:col-span-4">
          冻结并派发
        </button>
      </form>

      <div className="flex gap-2 overflow-x-auto">
        {(["all", "holding", "dispatched", "dead_letter", "settled", "refunded"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onFilter(item)}
            className={`min-h-11 shrink-0 rounded-full px-3 text-sm ${stateFilter === item ? "bg-surface-2" : "text-muted"}`}
          >
            {item === "all" ? "全部" : item === "holding" ? "在途" : STATE_LABEL[item]}
          </button>
        ))}
        <input
          className="min-h-11 min-w-36 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          placeholder="搜索标题或商户"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <JobList jobs={[...jobs].reverse()} merchants={world.merchants} onSelect={onSelect} activeId={selected?.id ?? null} />
        <JobDetail job={selected} world={world} onAct={onAct} />
      </div>
    </div>
  );
}

function Failures({
  world,
  now,
  selected,
  onSelect,
  onAct,
  onTick,
}: {
  world: World;
  now: number;
  selected: Job | null;
  onSelect: (id: string) => void;
  onAct: (command: Command) => void;
  onTick: () => void;
}) {
  const dead = world.jobs.filter((job) => job.state === "dead_letter");
  const retrying = world.jobs.filter((job) => job.state === "dispatched" && job.nextRetryAt > 0);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-4">
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">死信 · 预授权仍冻结</h2>
            <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={onTick}>
              唤醒到期重试
            </button>
          </div>
          <JobList jobs={dead} merchants={world.merchants} onSelect={onSelect} activeId={selected?.id ?? null} />
        </section>
        <section>
          <h2 className="mb-2 text-sm font-medium">退避中</h2>
          {retrying.length === 0 ? <p className="text-sm text-muted">没有等待退避的任务。</p> : null}
          <div className="flex flex-col gap-2">
            {retrying.map((job) => (
              <button key={job.id} type="button" onClick={() => onSelect(job.id)} className="rounded-xl border border-line bg-surface p-3 text-left">
                <p className="font-medium">{job.title}</p>
                <p className="text-sm text-muted">
                  {job.lastError} · {job.nextRetryAt <= now ? "已到期" : `最早 ${formatTime(job.nextRetryAt)}`}
                </p>
              </button>
            ))}
          </div>
        </section>
      </div>
      <JobDetail job={selected} world={world} onAct={onAct} />
    </div>
  );
}

function Observe({
  world,
  report,
  violations,
}: {
  world: World;
  report: ReturnType<typeof slo>;
  violations: ReturnType<typeof audit>;
}) {
  const events = [...world.events].reverse().slice(0, 40);
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-medium">SLO {formatPct(report.target)}</h2>
        <p className="mt-1 text-sm text-muted">
          样本 {report.sample} · 干净终态 {report.good} · 死信或核销 {report.bad} · 当前 {formatPct(report.rate)}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full bg-ok" style={{ width: `${Math.min(100, report.rate * 100)}%` }} />
        </div>
        <p className="mt-3 text-sm">{violations.length === 0 ? "对账通过。" : `对账失败 ${violations.length} 条。`}</p>
      </section>
      <section className="rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line px-4 py-3 text-sm font-medium">最近迁移</h2>
        <ul className="divide-y divide-line">
          {events.map((event) => (
            <li key={event.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs text-accent">{event.code}</p>
                <p className="font-mono text-xs text-muted">{formatTime(event.ts)}</p>
              </div>
              <p className="mt-1 text-sm">{event.message}</p>
              <p className="mt-1 text-xs text-muted">
                {event.traceId || "无 trace"} {event.jobId ? `· ${event.jobId}` : ""} {event.from ? `· ${event.from} → ${event.to}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function JobList({
  jobs,
  merchants,
  onSelect,
  activeId,
}: {
  jobs: Job[];
  merchants: Merchant[];
  onSelect: (id: string) => void;
  activeId: string | null;
}) {
  if (jobs.length === 0) return <p className="text-sm text-muted">没有匹配的任务。</p>;
  return (
    <div className="flex flex-col gap-2">
      {jobs.map((job) => {
        const merchant = merchants.find((item) => item.id === job.merchantId);
        return (
          <button
            key={job.id}
            type="button"
            onClick={() => onSelect(job.id)}
            className={`rounded-xl border p-3 text-left ${job.id === activeId ? "border-accent bg-surface" : "border-line bg-surface"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{job.title}</p>
                <p className="truncate text-sm text-muted">{merchant?.name} · {skuLabel(job.sku)} · {job.id}</p>
              </div>
              <span className={`shrink-0 text-xs ${stateTone(job.state)}`}>{STATE_LABEL[job.state]}</span>
            </div>
            <p className="mt-2 font-mono text-sm">{formatUsdc(job.quoteMicro)}</p>
          </button>
        );
      })}
    </div>
  );
}

function JobDetail({ job, world, onAct }: { job: Job | null; world: World; onAct: (command: Command) => void }) {
  const [errorCode, setErrorCode] = useState<ErrorCode>("RENDER_NODE_TIMEOUT");
  if (!job) return <aside className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">选择一笔任务查看迁移与补偿。</aside>;
  const merchant = world.merchants.find((item) => item.id === job.merchantId);
  const timeline = world.events.filter((event) => event.jobId === job.id).slice(-8).reverse();
  return (
    <aside className="rounded-xl border border-line bg-surface p-4">
      <p className={`text-xs ${stateTone(job.state)}`}>{STATE_LABEL[job.state]}</p>
      <h2 className="mt-1 text-lg font-semibold">{job.title}</h2>
      <p className="text-sm text-muted">{merchant?.name} · {job.traceId}</p>
      <p className="mt-2 font-mono text-sm">{formatUsdc(job.quoteMicro)}</p>
      {job.feeBpsLocked ? <p className="text-xs text-muted">锁定费率 {(job.feeBpsLocked / 100).toFixed(2)}%</p> : null}
      {job.lastError ? <p className="mt-2 text-sm text-danger">{job.lastError} · {job.failureClass} · 尝试 {job.attempts}</p> : null}
      <div className="mt-3 flex flex-col gap-2">
        {job.state === "reserved" ? (
          <button type="button" className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg" onClick={() => onAct({ type: "dispatch", jobId: job.id, idempotencyKey: freshKey("dispatch") })}>
            派发
          </button>
        ) : null}
        {job.state === "dispatched" ? (
          <>
            <button type="button" className="min-h-11 rounded-lg bg-accent px-3 text-sm font-medium text-bg" onClick={() => onAct({ type: "complete", jobId: job.id, idempotencyKey: freshKey("done") })}>
              结算成功
            </button>
            <label className="text-sm">
              <span className="mb-1 block text-muted">注入失败</span>
              <select className="min-h-11 w-full rounded-lg border border-line bg-bg px-2" value={errorCode} onChange={(event) => setErrorCode(event.target.value as ErrorCode)}>
                {Object.keys(ERROR_CATALOG).map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
            </label>
            <button type="button" className="min-h-11 rounded-lg border border-danger/40 px-3 text-sm text-danger" onClick={() => onAct({ type: "fail", jobId: job.id, errorCode, idempotencyKey: freshKey("fail") })}>
              上报失败
            </button>
          </>
        ) : null}
        {job.state === "dead_letter" ? (
          <>
            <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "retry", jobId: job.id, reason: "渲染池已恢复", actor: ACTOR, idempotencyKey: freshKey("retry") })}>
              重试
            </button>
            <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "refund", jobId: job.id, reason: "商户要求停单", actor: ACTOR, idempotencyKey: freshKey("refund") })}>
              全额退款
            </button>
            <button type="button" className="min-h-11 rounded-lg border border-danger/40 px-3 text-sm text-danger" onClick={() => onAct({ type: "operator", action: "write_off", jobId: job.id, reason: "工单 LS-演练 核销", actor: ACTOR, idempotencyKey: freshKey("wo") })}>
              核销为损耗
            </button>
          </>
        ) : null}
        {job.state === "reserved" || (job.state === "dispatched" && job.lastError) ? (
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "refund", jobId: job.id, reason: "值班提前退款", actor: ACTOR, idempotencyKey: freshKey("refund") })}>
            退回预授权
          </button>
        ) : null}
        {job.lastWebhook ? (
          <button type="button" className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => onAct({ type: "operator", action: "replay", jobId: job.id, reason: "回放最近一次回调", actor: ACTOR })}>
            回放回调
          </button>
        ) : null}
      </div>
      <ol className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
        {timeline.map((event) => (
          <li key={event.id} className="text-xs">
            <span className="font-mono text-accent">{event.code}</span>
            <span className="text-muted"> · {formatTime(event.ts)}</span>
            <p>{event.message}</p>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg ${tone ?? ""}`}>{value}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg px-2 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

function freshKey(prefix: string): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  return `${prefix}-${raw}`.slice(0, 80);
}
