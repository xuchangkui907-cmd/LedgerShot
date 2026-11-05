-- A production job is payable only after its deterministic Anchor PDA and
-- associated token vault have been registered and verified by the server.
alter table jobs add column if not exists payer_wallet text;
alter table jobs add column if not exists onchain_job_address text;
alter table jobs add column if not exists vault_token_account text;

create unique index if not exists jobs_onchain_job_address_idx
  on jobs (onchain_job_address) where onchain_job_address is not null;
create unique index if not exists jobs_vault_token_account_idx
  on jobs (vault_token_account) where vault_token_account is not null;
