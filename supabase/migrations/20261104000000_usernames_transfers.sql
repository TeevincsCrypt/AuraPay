-- Usernames and wallet-to-wallet transfers (NIM and USDT) between AuraPay users.

-- @username: lowercase letters, digits and underscores, 3-20 chars, starting with a letter.
alter table users add column if not exists username text;
alter table users add column if not exists username_set_at timestamptz;
-- The address that receives USDT sent to this user's @username (one of their verified EVM wallets).
alter table users add column if not exists receive_evm_address text;
create unique index if not exists users_username_uidx on users (username) where username is not null;
alter table users drop constraint if exists users_username_format;
alter table users add constraint users_username_format check (username is null or username ~ '^[a-z][a-z0-9_]{2,19}$');

-- Transfers are sent directly from the sender's wallet to the recipient's wallet; AuraPay
-- never holds the funds. A row records who sent what to whom, verified on-chain.
create table if not exists transfers (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique,
  from_user_id     uuid not null references users(id) on delete restrict,
  to_user_id       uuid not null references users(id) on delete restrict,
  currency         text not null check (currency in ('NIM', 'USDT')),
  chain            text not null check (chain in ('nimiq', 'polygon')),
  network          text not null,
  amount           numeric(30, 8) not null,
  amount_atomic    text not null,
  from_address     text not null,
  to_address       text not null,
  note             text,
  memo             text,
  tx_hash          text,
  status           text not null check (status in ('created', 'pending', 'confirmed', 'failed', 'expired')),
  failure_reason   text,
  amount_usd       numeric(20, 4),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  unique (chain, tx_hash)
);
create index if not exists transfers_from_idx on transfers (from_user_id, created_at desc);
create index if not exists transfers_to_idx on transfers (to_user_id, created_at desc);
alter table transfers enable row level security;

alter table transactions drop constraint if exists transactions_category_check;
alter table transactions add constraint transactions_category_check check (category in (
  'stock_purchase', 'utility_purchase', 'loan_disbursement', 'loan_repayment',
  'collateral_deposit', 'collateral_withdrawal', 'wallet_payment', 'refund', 'bill_schedule',
  'transfer_sent', 'transfer_received'));
