-- Display currency, recurring payments / bill reminders, and savings circles (ajo).

-- ---------------------------------------------------------------------------
-- Display currency: amounts are also shown in this fiat currency.
-- ---------------------------------------------------------------------------
alter table users add column if not exists display_currency text not null default 'USD';
alter table users drop constraint if exists users_display_currency_check;
alter table users add constraint users_display_currency_check check (display_currency in ('USD', 'NGN', 'GHS', 'KES', 'UGX', 'ZAR', 'TZS'));

-- ---------------------------------------------------------------------------
-- Recurring payments & bill reminders. Self-custodial wallets can't be charged
-- automatically, so each item becomes due on schedule and is paid with one tap
-- (prefilled). It advances only when a matching payment is verified.
-- ---------------------------------------------------------------------------
create table if not exists recurring_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  kind          text not null check (kind in ('bill', 'transfer')),
  title         text not null,
  payload       jsonb not null,
  frequency     text not null check (frequency in ('once', 'weekly', 'monthly')),
  next_due_at   timestamptz,
  active        boolean not null default true,
  last_paid_at  timestamptz,
  last_payment_ref text,
  times_paid    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists recurring_items_user_idx on recurring_items (user_id, next_due_at);
alter table recurring_items enable row level security;

-- ---------------------------------------------------------------------------
-- Savings circles (rotating savings: ajo / esusu / chama). Each round, every
-- member pays that round's recipient directly, wallet to wallet; AuraPay
-- verifies and tracks contributions and never holds the money.
-- ---------------------------------------------------------------------------
create table if not exists savings_circles (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null unique,
  name                text not null,
  organizer_id        uuid not null references users(id) on delete restrict,
  currency            text not null check (currency in ('NIM', 'USDT')),
  contribution        numeric(30, 8) not null,
  contribution_atomic text not null,
  frequency           text not null check (frequency in ('weekly', 'monthly')),
  start_at            timestamptz not null,
  status              text not null check (status in ('forming', 'active', 'completed', 'cancelled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table savings_circles enable row level security;

create table if not exists circle_members (
  circle_id   uuid not null references savings_circles(id) on delete cascade,
  user_id     uuid not null references users(id) on delete restrict,
  position    integer not null,
  status      text not null check (status in ('invited', 'joined', 'declined')),
  joined_at   timestamptz,
  primary key (circle_id, user_id),
  unique (circle_id, position)
);
create index if not exists circle_members_user_idx on circle_members (user_id);
alter table circle_members enable row level security;

-- A contribution is a verified transfer tagged with its circle and round.
alter table transfers add column if not exists circle_id uuid references savings_circles(id);
alter table transfers add column if not exists circle_round integer;
create index if not exists transfers_circle_idx on transfers (circle_id, circle_round) where circle_id is not null;
