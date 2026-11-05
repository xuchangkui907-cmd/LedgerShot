-- Commercial books: hash lock, studio origin, treasury float, and chain log.
-- Existing checks stay fail-closed. New columns are additive.

alter table jobs add column if not exists chain_job_id text;
alter table jobs add column if not exists spec_hash text not null default '';
alter table jobs add column if not exists expected_hash text not null default '';
alter table jobs add column if not exists output_hash text not null default '';
alter table jobs add column if not exists ops_key text;
alter table jobs add column if not exists origin text not null default 'prepaid';

alter table jobs alter column price_atomic type bigint;
alter table ledger_entries alter column amount_atomic type bigint;
alter table payment_receipts alter column amount_atomic type bigint;

do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table jobs drop constraint %I', r.conname);
  end loop;
end $$;

alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs
  add constraint jobs_kind_check
  check (kind in ('product_shot', 'dub', 'short'));

alter table jobs drop constraint if exists jobs_origin_check;
alter table jobs
  add constraint jobs_origin_check
  check (origin in ('prepaid', 'chain'));

create unique index if not exists jobs_ops_key_uq on jobs (ops_key);
create unique index if not exists jobs_chain_job_id_uq on jobs (chain_job_id);

create table if not exists desk_treasury (
  id text primary key,
  opening_atomic bigint not null check (opening_atomic >= 0),
  ops_now_ms bigint not null default 0,
  ops_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into desk_treasury (id, opening_atomic, ops_now_ms, ops_seq)
values ('devnet', 2000000, 0, 0)
on conflict (id) do nothing;

create table if not exists chain_log (
  id bigserial primary key,
  chain_job_id text not null default '',
  ok boolean not null,
  ix text not null,
  code text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists ops_audit_request_uq
  on ops_audit_events (request_id)
  where request_id <> '';