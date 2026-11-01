-- AuraPay initial schema.
--
-- Security model:
--   * All tables have Row Level Security enabled and NO policies, so the public
--     `anon` / `authenticated` Supabase roles can read or write nothing.
--   * The AuraPay server connects with a privileged connection string
--     (DATABASE_URL) and enforces ownership in application code.
--   * No private keys, seed phrases, API secrets or access tokens are stored.
--   * Real and simulated records are separated by explicit columns
--     (is_simulated / is_simulated_payment / environment) that are never inferred.

-- ---------------------------------------------------------------------------
-- Users & wallets
-- ---------------------------------------------------------------------------

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  -- SHA-256 of the opaque session id held in an HttpOnly cookie.
  session_hash  text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table if not exists wallet_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  chain          text not null check (chain in ('nimiq', 'polygon')),
  network        text not null,
  address        text not null,
  -- 'nimiq_pay' = Nimiq provider, 'evm_provider' = window.ethereum.
  source         text not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (user_id, chain, address)
);
create index if not exists wallet_connections_address_idx on wallet_connections (address);

-- ---------------------------------------------------------------------------
-- Exchange rates (audit trail of every rate used in a quote)
-- ---------------------------------------------------------------------------

create table if not exists exchange_rates (
  id          bigserial primary key,
  base        text not null,           -- 'NIM' | 'USDT'
  quote       text not null default 'USD',
  rate        numeric(30, 12) not null, -- units of quote per 1 base
  source      text not null,
  fetched_at  timestamptz not null default now()
);
create index if not exists exchange_rates_base_time_idx on exchange_rates (base, fetched_at desc);

-- ---------------------------------------------------------------------------
-- Utility orders (airtime, data, electricity)
-- ---------------------------------------------------------------------------

create table if not exists utility_orders (
  id                    uuid primary key default gen_random_uuid(),
  ref                   text not null unique,
  user_id               uuid not null references users(id) on delete restrict,
  client_request_id     text not null,
  environment           text not null check (environment in ('sandbox', 'production')),
  service               text not null check (service in ('airtime', 'data', 'electricity')),
  country_code          char(2) not null,
  provider              text not null default 'reloadly',
  operator_id           integer not null,
  operator_name         text not null,
  recipient             text not null,
  recipient_label       text,
  product_description   text,
  amount_local          numeric(20, 4),
  local_currency        text,
  amount_sender         numeric(20, 4) not null,
  sender_currency       text not null,
  use_local_amount      boolean not null default false,
  provider_cost_usd     numeric(20, 4) not null,
  service_fee_usd       numeric(20, 4) not null,
  total_usd             numeric(20, 4) not null,
  pay_currency          text not null check (pay_currency in ('NIM', 'USDT', 'DEMO')),
  pay_amount            numeric(30, 8) not null,
  pay_amount_atomic     text not null,      -- luna (NIM) or 6-dp units (USDT)
  exchange_rate         numeric(30, 12) not null, -- USD per 1 unit of pay currency
  rate_source           text not null,
  payer_address         text,
  pay_to_address        text,
  memo                  text,
  status                text not null check (status in (
                          'quoted', 'payment_pending', 'paid', 'fulfilling',
                          'provider_pending', 'successful', 'failed', 'expired',
                          'requires_review', 'refunded')),
  status_reason         text,
  is_simulated_payment  boolean not null default false,
  provider_transaction_id text,
  provider_status       text,
  provider_response     jsonb,
  delivery_details      jsonb,
  expires_at            timestamptz not null,
  paid_at               timestamptz,
  fulfilled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, client_request_id)
);
create index if not exists utility_orders_user_idx on utility_orders (user_id, created_at desc);
create index if not exists utility_orders_open_status_idx on utility_orders (status)
  where status in ('payment_pending', 'paid', 'fulfilling', 'provider_pending', 'requires_review');

-- ---------------------------------------------------------------------------
-- On-chain payments (incoming and refunds). One tx hash can only ever be
-- claimed once, across every order type.
-- ---------------------------------------------------------------------------

create table if not exists payments (
  id               uuid primary key default gen_random_uuid(),
  order_kind       text not null check (order_kind in ('utility', 'stock', 'loan')),
  order_id         uuid not null,
  direction        text not null default 'in' check (direction in ('in', 'refund')),
  chain            text not null check (chain in ('nimiq', 'polygon', 'demo')),
  tx_hash          text not null,
  payer_address    text,
  amount_atomic    text not null,
  status           text not null check (status in ('submitted', 'confirmed', 'rejected')),
  failure_reason   text,
  verification     jsonb,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  unique (chain, tx_hash)
);
create unique index if not exists payments_one_confirmed_in_per_order
  on payments (order_kind, order_id) where status = 'confirmed' and direction = 'in';
create index if not exists payments_order_idx on payments (order_kind, order_id);

-- ---------------------------------------------------------------------------
-- Unified activity ledger
-- ---------------------------------------------------------------------------

create table if not exists transactions (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique,
  user_id         uuid not null references users(id) on delete restrict,
  category        text not null check (category in (
                    'stock_purchase', 'utility_purchase', 'loan_disbursement',
                    'loan_repayment', 'wallet_payment', 'refund')),
  title           text not null,
  subtitle        text,
  amount          numeric(30, 8) not null,
  currency        text not null,
  amount_usd      numeric(20, 4),
  status          text not null check (status in (
                    'pending', 'processing', 'successful', 'failed', 'refunded', 'requires_review')),
  is_simulated    boolean not null default false,
  -- 'production' | 'sandbox' | 'simulated'
  environment     text not null,
  provider        text,
  provider_ref    text,
  chain_tx_hash   text,
  source_table    text not null,
  source_id       uuid not null,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists transactions_user_idx on transactions (user_id, created_at desc);
create index if not exists transactions_source_idx on transactions (source_table, source_id);

-- ---------------------------------------------------------------------------
-- Saved beneficiaries
-- ---------------------------------------------------------------------------

create table if not exists saved_beneficiaries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  kind           text not null check (kind in ('phone', 'meter')),
  country_code   char(2) not null,
  label          text not null,
  value          text not null,
  operator_id    integer,
  operator_name  text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  unique (user_id, kind, country_code, value)
);

-- ---------------------------------------------------------------------------
-- Investing. Market data is never stored as ownership. Positions are either
-- provider-verified (is_simulated = false, verified_at set) or simulated.
-- ---------------------------------------------------------------------------

create table if not exists stocks (
  symbol       text primary key,
  name         text not null,
  exchange     text not null,
  sector       text not null,
  description  text not null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0
);

create table if not exists stock_orders (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null unique,
  user_id             uuid not null references users(id) on delete restrict,
  symbol              text not null references stocks(symbol),
  side                text not null default 'buy' check (side in ('buy', 'sell')),
  notional_usd        numeric(20, 4) not null,
  quantity            numeric(24, 10) not null,
  price_usd           numeric(20, 6) not null,
  fee_usd             numeric(20, 4) not null default 0,
  pay_currency        text not null,
  pay_amount          numeric(30, 8) not null,
  exchange_rate       numeric(30, 12),
  price_source        text not null,
  status              text not null check (status in (
                        'simulated_filled', 'pending', 'filled', 'rejected', 'cancelled')),
  is_simulated        boolean not null,
  execution_provider  text,
  provider_order_id   text,
  created_at          timestamptz not null default now(),
  filled_at           timestamptz
);
create index if not exists stock_orders_user_idx on stock_orders (user_id, created_at desc);

create table if not exists stock_positions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  symbol          text not null references stocks(symbol),
  quantity        numeric(24, 10) not null check (quantity >= 0),
  cost_basis_usd  numeric(20, 4) not null,
  is_simulated    boolean not null,
  provider        text,
  verified_at     timestamptz,
  updated_at      timestamptz not null default now(),
  unique (user_id, symbol, is_simulated)
);

-- ---------------------------------------------------------------------------
-- Lending
-- ---------------------------------------------------------------------------

create table if not exists loans (
  id                       uuid primary key default gen_random_uuid(),
  ref                      text not null unique,
  user_id                  uuid not null references users(id) on delete restrict,
  is_simulated             boolean not null,
  provider                 text,
  principal_usdt           numeric(20, 6) not null check (principal_usdt > 0),
  apr                      numeric(8, 6) not null,
  term_days                integer not null,
  max_ltv                  numeric(6, 4) not null,
  liquidation_ltv          numeric(6, 4) not null,
  collateral_value_at_open numeric(20, 4) not null,
  repaid_usdt              numeric(20, 6) not null default 0,
  status                   text not null check (status in ('active', 'repaid', 'liquidated', 'cancelled')),
  opened_at                timestamptz not null default now(),
  due_at                   timestamptz not null,
  closed_at                timestamptz,
  updated_at               timestamptz not null default now()
);
create index if not exists loans_user_idx on loans (user_id, opened_at desc);

create table if not exists loan_collateral (
  id             uuid primary key default gen_random_uuid(),
  loan_id        uuid not null references loans(id) on delete cascade,
  symbol         text not null references stocks(symbol),
  quantity       numeric(24, 10) not null check (quantity > 0),
  value_at_lock  numeric(20, 4) not null,
  is_simulated   boolean not null,
  created_at     timestamptz not null default now()
);
create index if not exists loan_collateral_loan_idx on loan_collateral (loan_id);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

insert into stocks (symbol, name, exchange, sector, description, sort_order) values
  ('NVDA', 'NVIDIA', 'NASDAQ', 'Semiconductors', 'Designs GPUs and accelerated-computing platforms used in gaming, data centres and AI workloads.', 1),
  ('AAPL', 'Apple', 'NASDAQ', 'Consumer Technology', 'Makes the iPhone, Mac, iPad and wearables, and runs services such as the App Store, iCloud and Apple Pay.', 2),
  ('MSFT', 'Microsoft', 'NASDAQ', 'Software & Cloud', 'Develops Windows, Office and the Azure cloud platform, alongside LinkedIn, GitHub and Xbox.', 3),
  ('TSLA', 'Tesla', 'NASDAQ', 'Automotive & Energy', 'Builds electric vehicles, battery storage and solar products, and develops driver-assistance software.', 4),
  ('AMZN', 'Amazon', 'NASDAQ', 'E-commerce & Cloud', 'Operates a global online marketplace and logistics network, and Amazon Web Services (AWS).', 5),
  ('GOOGL', 'Alphabet', 'NASDAQ', 'Internet Services', 'Parent company of Google Search, YouTube, Android and Google Cloud.', 6),
  ('META', 'Meta Platforms', 'NASDAQ', 'Internet Services', 'Runs Facebook, Instagram, WhatsApp and Messenger, and invests in AI and virtual reality.', 7),
  ('AMD', 'AMD', 'NASDAQ', 'Semiconductors', 'Designs CPUs, GPUs and adaptive chips for PCs, game consoles, data centres and embedded systems.', 8),
  ('NFLX', 'Netflix', 'NASDAQ', 'Media & Streaming', 'Subscription streaming service offering films, series and games in over 190 countries.', 9),
  ('COIN', 'Coinbase', 'NASDAQ', 'Financial Services', 'Operates a regulated crypto-asset exchange, custody and payments platform.', 10)
on conflict (symbol) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security: deny-by-default for Supabase client roles.
-- ---------------------------------------------------------------------------

alter table users                enable row level security;
alter table wallet_connections   enable row level security;
alter table exchange_rates       enable row level security;
alter table utility_orders       enable row level security;
alter table payments             enable row level security;
alter table transactions         enable row level security;
alter table saved_beneficiaries  enable row level security;
alter table stocks               enable row level security;
alter table stock_orders         enable row level security;
alter table stock_positions      enable row level security;
alter table loans                enable row level security;
alter table loan_collateral      enable row level security;

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
