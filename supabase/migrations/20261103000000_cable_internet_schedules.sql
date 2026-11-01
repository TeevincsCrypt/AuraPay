-- Cable TV and internet bills, and prepaid scheduled bills.

-- New bill services.
alter table utility_orders drop constraint if exists utility_orders_service_check;
alter table utility_orders add constraint utility_orders_service_check
  check (service in ('airtime', 'data', 'electricity', 'cable', 'internet'));

-- ---------------------------------------------------------------------------
-- Scheduled bills. The user prepays every run of a schedule in one verified
-- on-chain payment; at each run time AuraPay creates a normal (already paid)
-- utility order and fulfils it through the usual exactly-once path.
-- ---------------------------------------------------------------------------

create table if not exists bill_schedules (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null unique,
  user_id             uuid not null references users(id) on delete restrict,
  client_request_id   text not null,
  environment         text not null check (environment in ('sandbox', 'production')),
  provider            text not null,
  service             text not null check (service in ('airtime', 'data', 'electricity', 'cable', 'internet')),
  country_code        char(2) not null,
  operator_code       text not null,
  operator_name       text not null,
  item_code           text,
  recipient           text not null,
  recipient_label     text,
  product_description text,
  amount_local        numeric(20, 4),
  local_currency      text,
  amount_sender       numeric(20, 4) not null,
  sender_currency     text not null,
  use_local_amount    boolean not null default true,
  provider_cost_usd   numeric(20, 4) not null,  -- per run
  service_fee_usd     numeric(20, 4) not null,  -- per run
  per_run_usd         numeric(20, 4) not null,
  frequency           text not null check (frequency in ('once', 'weekly', 'monthly')),
  total_runs          integer not null check (total_runs between 1 and 12),
  runs_done           integer not null default 0,
  start_at            timestamptz not null,
  next_run_at         timestamptz,
  last_run_at         timestamptz,
  total_usd           numeric(20, 4) not null,
  pay_currency        text not null check (pay_currency in ('NIM', 'USDT')),
  pay_amount          numeric(30, 8) not null,
  pay_amount_atomic   text not null,
  exchange_rate       numeric(30, 12) not null,
  rate_source         text not null,
  payer_address       text,
  pay_to_address      text,
  memo                text,
  status              text not null check (status in (
                        'quoted', 'payment_pending', 'active', 'completed', 'cancelled',
                        'expired', 'requires_review', 'refunded')),
  status_reason       text,
  refund_due_atomic   text,
  expires_at          timestamptz not null,
  paid_at             timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, client_request_id)
);
create index if not exists bill_schedules_due_idx on bill_schedules (next_run_at) where status = 'active';
create index if not exists bill_schedules_user_idx on bill_schedules (user_id, created_at desc);
alter table bill_schedules enable row level security;

-- Each run is a utility order; (schedule, run) is unique so a run can only ever be created once.
alter table utility_orders add column if not exists schedule_id uuid references bill_schedules(id);
alter table utility_orders add column if not exists schedule_run integer;
create unique index if not exists utility_orders_schedule_run_uidx on utility_orders (schedule_id, schedule_run) where schedule_id is not null;

-- Schedule payments share the payments table (one tx hash, one use).
alter table payments drop constraint if exists payments_order_kind_check;
alter table payments add constraint payments_order_kind_check check (order_kind in ('utility', 'stock', 'loan', 'schedule'));

-- Ledger entry for funding a schedule.
alter table transactions drop constraint if exists transactions_category_check;
alter table transactions add constraint transactions_category_check check (category in (
  'stock_purchase', 'utility_purchase', 'loan_disbursement', 'loan_repayment',
  'collateral_deposit', 'collateral_withdrawal', 'wallet_payment', 'refund', 'bill_schedule'));
