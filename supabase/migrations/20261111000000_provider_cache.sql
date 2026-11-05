-- Shared cache for provider catalogues (bill categories, billers, items, FX). Serverless instances
-- otherwise each refetch them, which multiplies calls through the static-IP proxy.
create table if not exists provider_cache (
  key         text primary key,
  value_json  text not null,
  fetched_at  timestamptz not null default now()
);
alter table provider_cache enable row level security;
