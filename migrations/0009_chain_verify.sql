-- Independent RPC verification flags. Amounts also stored as text so u64 never
-- goes through a float. Existing rows stay unverified until re-checked.
alter table chain_tx add column if not exists amount_atomic_text text not null default '';
alter table chain_tx add column if not exists chain_ok boolean not null default false;
alter table chain_tx add column if not exists program_ok boolean not null default false;
alter table chain_tx add column if not exists mint_ok boolean not null default false;
alter table chain_tx add column if not exists amount_ok boolean not null default false;
alter table chain_tx add column if not exists accounts_ok boolean not null default false;
alter table chain_tx add column if not exists parsed_ix text not null default '';
alter table chain_tx add column if not exists verify_issues text not null default '';
