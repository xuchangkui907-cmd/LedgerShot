-- Immutable log of Solana transactions sent to ledger_shot.
-- Ids are issued by the app so this applies on PGLite without pgcrypto.

create table if not exists chain_tx (
  id text primary key,
  chain_job_id text not null default '',
  tx_signature text not null,
  instruction text not null,
  slot bigint,
  confirm_time timestamptz,
  status text not null default 'pending',
  payer text not null default '',
  merchant text not null default '',
  amount_atomic bigint not null default 0,
  output_hash text not null default '',
  error_code text not null default '',
  logs text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists chain_tx_signature_uq on chain_tx (tx_signature);
create index if not exists chain_tx_job_idx on chain_tx (chain_job_id);
create index if not exists chain_tx_created_idx on chain_tx (created_at desc);

alter table jobs add column if not exists onchain_status text;
alter table jobs add column if not exists last_synced_at timestamptz;
