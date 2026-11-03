-- Operator retries of orders the provider definitely rejected (nothing delivered). Each retry is
-- sent with a new provider reference (<ref>-R<n>) so it can never be confused with the rejected one.
alter table utility_orders add column if not exists fulfil_attempts integer not null default 0;
