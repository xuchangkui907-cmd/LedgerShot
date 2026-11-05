-- Studio escrow books. Rows are unowned: a job id is the capability.
-- No personal data. Briefs describe a product, not a person.

create table if not exists jobs (
  id uuid primary key,
  sku text not null,
  title text not null,
  kind text not null check (kind in ('product_shot', 'dub')),
  locale text not null check (locale in ('en', 'es', 'ja', 'zh')),
  brief text not null default '',
  price_atomic integer not null check (price_atomic > 0),
  status text not null check (status in ('quoted', 'funded', 'released', 'refunded')),
  deadline timestamptz not null,
  settlement_ref text,
  output_svg text,
  output_sha256 text,
  fail_reason text,
  created_at timestamptz not null default now(),
  funded_at timestamptz,
  released_at timestamptz,
  refunded_at timestamptz
);

create index if not exists jobs_created_idx on jobs (created_at desc);

create table if not exists ledger_entries (
  id uuid primary key,
  job_id uuid not null references jobs (id),
  side text not null check (side in ('debit', 'credit')),
  account text not null check (account in ('vault', 'payer_clearing', 'merchant_cash')),
  amount_atomic integer not null check (amount_atomic > 0),
  memo text not null,
  created_at timestamptz not null default now()
);

create index if not exists ledger_job_idx on ledger_entries (job_id);

create table if not exists payment_events (
  id uuid primary key,
  job_id uuid not null references jobs (id),
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists events_job_idx on payment_events (job_id, created_at);
