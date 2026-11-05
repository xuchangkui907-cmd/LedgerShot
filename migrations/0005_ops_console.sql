-- LedgerShot operations console persistence.
-- This migration extends the existing jobs/ledger/payment schema; it does not
-- rewrite or reinterpret the canonical on-chain job status.

CREATE TABLE IF NOT EXISTS ops_merchants (
  id text PRIMARY KEY,
  name text NOT NULL,
  desk text NOT NULL DEFAULT '',
  pool text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  wallet text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'frozen', 'settlement_hold')),
  resume_status text NOT NULL DEFAULT 'active'
    CHECK (resume_status IN ('active', 'settlement_hold')),
  risk text NOT NULL DEFAULT 'low'
    CHECK (risk IN ('low', 'medium', 'high')),
  fee_bps integer NOT NULL DEFAULT 500
    CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  credit_atomic bigint NOT NULL DEFAULT 0 CHECK (credit_atomic >= 0),
  reserved_atomic bigint NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  platform_revenue_atomic bigint NOT NULL DEFAULT 0 CHECK (platform_revenue_atomic >= 0),
  supplier_payable_atomic bigint NOT NULL DEFAULT 0 CHECK (supplier_payable_atomic >= 0),
  platform_loss_atomic bigint NOT NULL DEFAULT 0 CHECK (platform_loss_atomic >= 0),
  opening_atomic bigint NOT NULL DEFAULT 0 CHECK (opening_atomic >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep operational workflow separate from the chain/payment status column.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS ops_merchant_id text,
  ADD COLUMN IF NOT EXISTS ops_state text NOT NULL DEFAULT 'quoted',
  ADD COLUMN IF NOT EXISTS fee_bps_locked integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_atomic bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_atomic bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS failure_class text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_webhook jsonb,
  ADD COLUMN IF NOT EXISTS ops_updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE jobs ADD CONSTRAINT jobs_ops_state_check
    CHECK (ops_state IN ('quoted','reserved','dispatched','settled','refunded','dead_letter','written_off'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS jobs_ops_merchant_created_idx
  ON jobs (ops_merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_ops_state_retry_idx
  ON jobs (ops_state, next_retry_at)
  WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops_idempotency (
  idempotency_key text PRIMARY KEY,
  fingerprint text NOT NULL,
  ok boolean NOT NULL,
  result_code text NOT NULL,
  result_message text NOT NULL,
  job_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_audit_events (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  before_data jsonb,
  after_data jsonb,
  request_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_audit_events_created_idx
  ON ops_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ops_audit_events_entity_idx
  ON ops_audit_events (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops_incidents (
  id text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('sev2','sev3')),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigated','closed')),
  summary text NOT NULL DEFAULT '',
  job_id text,
  merchant_id text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ops_incidents_status_opened_idx
  ON ops_incidents (status, opened_at DESC);

-- Operational double-entry records are deliberately separate from chain
-- receipts. They describe internal accounting only, never an on-chain transfer.
CREATE TABLE IF NOT EXISTS ops_ledger_entries (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL,
  merchant_id text NOT NULL,
  entry_group text NOT NULL,
  side text NOT NULL CHECK (side IN ('debit','credit')),
  account text NOT NULL,
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_ledger_job_created_idx
  ON ops_ledger_entries (job_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ops_ledger_group_side_account_uq
  ON ops_ledger_entries (entry_group, side, account);
