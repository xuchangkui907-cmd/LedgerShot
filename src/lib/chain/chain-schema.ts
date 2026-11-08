import type { Sql } from "@/lib/db";

/**
 * Idempotent chain_tx shape. Production Neon only migrated at image build, so a
 * runtime database can be missing this table even though the SQL files exist.
 * Creating it here is safe to repeat and does not replay older ledger migrations.
 */
export const CHAIN_TX_STATEMENTS = [
  `create table if not exists chain_tx (
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
    amount_atomic_text text not null default '',
    output_hash text not null default '',
    error_code text not null default '',
    logs text not null default '',
    chain_ok boolean not null default false,
    program_ok boolean not null default false,
    mint_ok boolean not null default false,
    amount_ok boolean not null default false,
    accounts_ok boolean not null default false,
    parsed_ix text not null default '',
    verify_issues text not null default '',
    created_at timestamptz not null default now()
  )`,
  `alter table chain_tx add column if not exists amount_atomic_text text not null default ''`,
  `alter table chain_tx add column if not exists output_hash text not null default ''`,
  `alter table chain_tx add column if not exists error_code text not null default ''`,
  `alter table chain_tx add column if not exists logs text not null default ''`,
  `alter table chain_tx add column if not exists chain_ok boolean not null default false`,
  `alter table chain_tx add column if not exists program_ok boolean not null default false`,
  `alter table chain_tx add column if not exists mint_ok boolean not null default false`,
  `alter table chain_tx add column if not exists amount_ok boolean not null default false`,
  `alter table chain_tx add column if not exists accounts_ok boolean not null default false`,
  `alter table chain_tx add column if not exists parsed_ix text not null default ''`,
  `alter table chain_tx add column if not exists verify_issues text not null default ''`,
  `create unique index if not exists chain_tx_signature_uq on chain_tx (tx_signature)`,
  `create index if not exists chain_tx_job_idx on chain_tx (chain_job_id)`,
  `create index if not exists chain_tx_created_idx on chain_tx (created_at desc)`,
];

const globalSchema = globalThis as typeof globalThis & {
  __chainTxSchema__?: Promise<void>;
};

export async function ensureChainTxSchema(sql: Sql): Promise<void> {
  globalSchema.__chainTxSchema__ ??= (async () => {
    for (const statement of CHAIN_TX_STATEMENTS) {
      await sql.query(statement);
    }
  })().catch((error: unknown) => {
    globalSchema.__chainTxSchema__ = undefined;
    throw error;
  });
  await globalSchema.__chainTxSchema__;
}
