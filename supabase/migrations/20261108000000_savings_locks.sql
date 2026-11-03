-- Savings: USDT locked in the AuraPay Savings Vault contract on Polygon until a time the user
-- chose. The contract holds the funds; this table mirrors each lock and is only advanced from
-- verified receipts / on-chain reads.
create table if not exists savings_locks (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique,
  user_id          uuid not null references users(id) on delete restrict,
  label            text,
  chain            text not null default 'polygon' check (chain = 'polygon'),
  vault_address    text not null,
  owner_address    text not null,
  token            text not null,
  amount           numeric(38, 8),
  unlock_at        timestamptz,
  lock_id          numeric(78, 0),
  status           text not null check (status in ('pending', 'locked', 'released', 'failed')),
  lock_tx_hash     text not null,
  release_tx_hash  text,
  released_by      text check (released_by in ('owner', 'auto', 'other')),
  failure_reason   text,
  release_attempted_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  locked_at        timestamptz,
  released_at      timestamptz,
  unique (chain, lock_tx_hash),
  unique (vault_address, lock_id)
);
create unique index if not exists savings_locks_release_tx_idx on savings_locks (release_tx_hash) where release_tx_hash is not null;
create index if not exists savings_locks_user_idx on savings_locks (user_id, created_at desc);
create index if not exists savings_locks_due_idx on savings_locks (unlock_at) where status = 'locked';
alter table savings_locks enable row level security;

alter table transactions drop constraint if exists transactions_category_check;
alter table transactions add constraint transactions_category_check check (category in (
  'stock_purchase', 'utility_purchase', 'loan_disbursement', 'loan_repayment',
  'collateral_deposit', 'collateral_withdrawal', 'wallet_payment', 'refund', 'bill_schedule',
  'transfer_sent', 'transfer_received', 'earn_deposit', 'earn_withdraw', 'swap',
  'savings_lock', 'savings_release'));
