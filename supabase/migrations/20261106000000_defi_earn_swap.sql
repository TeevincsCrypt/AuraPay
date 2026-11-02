-- Earn (Aave V3 on Polygon) and Swap (QuickSwap on Polygon): the user's wallet sends every
-- transaction; AuraPay records it and verifies the receipt before showing it as completed.

create table if not exists defi_actions (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,
  user_id       uuid not null references users(id) on delete restrict,
  kind          text not null check (kind in ('earn_supply', 'earn_withdraw', 'swap')),
  chain         text not null default 'polygon' check (chain = 'polygon'),
  tx_hash       text not null,
  from_address  text not null,
  token_in      text,
  token_out     text,
  amount_in     numeric(38, 8),
  amount_out    numeric(38, 8),
  status        text not null check (status in ('pending', 'confirmed', 'failed')),
  failure_reason text,
  details       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  unique (chain, tx_hash)
);
create index if not exists defi_actions_user_idx on defi_actions (user_id, created_at desc);
alter table defi_actions enable row level security;

alter table transactions drop constraint if exists transactions_category_check;
alter table transactions add constraint transactions_category_check check (category in (
  'stock_purchase', 'utility_purchase', 'loan_disbursement', 'loan_repayment',
  'collateral_deposit', 'collateral_withdrawal', 'wallet_payment', 'refund', 'bill_schedule',
  'transfer_sent', 'transfer_received', 'earn_deposit', 'earn_withdraw', 'swap'));
