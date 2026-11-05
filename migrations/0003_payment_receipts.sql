-- An accepted chain transaction is a one-time payment receipt.
-- The unique signature constraint prevents reuse across jobs and retries.
create table if not exists payment_receipts (
  id uuid primary key,
  job_id uuid not null references jobs (id),
  transaction_signature text not null unique,
  payer text not null,
  destination text not null,
  amount_atomic integer not null check (amount_atomic > 0),
  slot bigint not null,
  verified_at timestamptz not null default now()
);

create unique index if not exists payment_receipts_job_idx on payment_receipts (job_id);
