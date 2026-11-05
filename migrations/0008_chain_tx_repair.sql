-- Repair path if an earlier 0007 created chain_tx without `logs`.
alter table chain_tx add column if not exists logs text not null default '';
alter table chain_tx add column if not exists error_code text not null default '';
alter table chain_tx add column if not exists output_hash text not null default '';
