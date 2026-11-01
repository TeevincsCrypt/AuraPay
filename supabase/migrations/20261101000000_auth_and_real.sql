-- AuraPay: wallet-signature authentication and real-only operation.
--
--  * Users are identified by a Nimiq address proven with a Nimiq Pay signature.
--  * Sessions are server-side rows; the cookie holds an opaque token (only its hash is stored).
--  * Sign-in challenges support both in-app signing and cross-device approval
--    (desktop/mobile browser shows a QR code; the user approves inside Nimiq Pay).
--  * Simulators were removed: simulated rows are deleted so nothing simulated can be
--    mistaken for real activity.
--  * Stock trades (CoW Protocol orders for tokenised stocks) and lending actions
--    (Aave V4 transactions) are recorded and verified against on-chain / provider state.

-- ---------------------------------------------------------------------------
-- Users: identity = Nimiq address
-- ---------------------------------------------------------------------------

alter table users alter column session_hash drop not null;
alter table users add column if not exists nimiq_address text unique;
alter table users add column if not exists nimiq_public_key text;

-- Legacy anonymous users (pre-authentication) keep their rows for referential integrity
-- but can no longer sign in; their data is not linked to any wallet.

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  user_id       uuid not null references users(id) on delete cascade,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id);

-- ---------------------------------------------------------------------------
-- Sign-in challenges
-- ---------------------------------------------------------------------------

create table if not exists auth_challenges (
  id               uuid primary key default gen_random_uuid(),
  -- 'local'  : signed in the same browser (inside Nimiq Pay)
  -- 'remote' : requested in another browser, approved inside Nimiq Pay via code / QR
  -- 'evm_link': links an EVM address to an authenticated user (personal_sign)
  kind             text not null check (kind in ('local', 'remote', 'evm_link')),
  message          text not null,
  code             text unique,
  poll_token_hash  text,
  status           text not null check (status in ('pending', 'approved', 'consumed', 'expired', 'rejected')),
  user_id          uuid references users(id) on delete cascade,
  address          text,
  requester_ua     text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  approved_at      timestamptz,
  consumed_at      timestamptz
);
create index if not exists auth_challenges_status_idx on auth_challenges (status, expires_at);

-- EVM wallets must now be proven with a signature before use.
alter table wallet_connections add column if not exists verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- Real investing: tokenised-stock trades placed through CoW Protocol
-- ---------------------------------------------------------------------------

create table if not exists stock_trades (
  id                   uuid primary key default gen_random_uuid(),
  ref                  text not null unique,
  user_id              uuid not null references users(id) on delete restrict,
  provider             text not null default 'cow',
  order_uid            text not null unique,
  chain_id             integer not null,
  target_chain_id      integer,
  owner                text not null,
  symbol               text not null references stocks(symbol),
  token_address        text not null,
  sell_token           text,
  sell_amount_atomic   text,
  sell_decimals        integer,
  buy_amount_atomic    text,
  executed_sell_atomic text,
  executed_buy_atomic  text,
  status               text not null check (status in ('open', 'fulfilled', 'expired', 'cancelled', 'unknown')),
  provider_status      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists stock_trades_user_idx on stock_trades (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Real lending: Aave V4 actions submitted from AuraPay
-- ---------------------------------------------------------------------------

create table if not exists lending_actions (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,
  user_id       uuid not null references users(id) on delete restrict,
  protocol      text not null default 'aave-v4',
  chain_id      integer not null,
  spoke         text not null,
  action        text not null check (action in ('approve', 'supply', 'withdraw', 'borrow', 'repay', 'set_collateral')),
  reserve_id    integer,
  symbol        text,
  amount_atomic text,
  decimals      integer,
  owner         text not null,
  tx_hash       text not null unique,
  status        text not null check (status in ('submitted', 'confirmed', 'failed')),
  failure_reason text,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz
);
create index if not exists lending_actions_user_idx on lending_actions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Remove simulated records (simulators no longer exist)
-- ---------------------------------------------------------------------------

delete from transactions where is_simulated = true;
delete from loan_collateral where is_simulated = true;
delete from loans where is_simulated = true;
delete from stock_positions where is_simulated = true;
delete from stock_orders where is_simulated = true;

-- Simulated-payment utility orders: remove them and their payments/ledger rows.
delete from payments where order_kind = 'utility' and order_id in (select id from utility_orders where is_simulated_payment = true);
delete from transactions where source_table = 'utility_orders' and source_id in (select id from utility_orders where is_simulated_payment = true);
delete from utility_orders where is_simulated_payment = true;

alter table utility_orders drop constraint if exists utility_orders_pay_currency_check;
alter table utility_orders add constraint utility_orders_pay_currency_check check (pay_currency in ('NIM', 'USDT'));
alter table payments drop constraint if exists payments_chain_check;
alter table payments add constraint payments_chain_check check (chain in ('nimiq', 'polygon'));

-- Ledger: lending categories now cover real Aave actions.
alter table transactions drop constraint if exists transactions_category_check;
alter table transactions add constraint transactions_category_check check (category in (
  'stock_purchase', 'utility_purchase', 'loan_disbursement', 'loan_repayment',
  'collateral_deposit', 'collateral_withdrawal', 'wallet_payment', 'refund'));

alter table sessions        enable row level security;
alter table auth_challenges enable row level security;
alter table stock_trades    enable row level security;
alter table lending_actions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
  end if;
end
$$;
