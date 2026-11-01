-- Utility providers: Pay can run on Flutterwave (string biller/item codes) or Reloadly
-- (numeric ids). Orders and saved recipients store provider codes as text.

alter table utility_orders add column if not exists operator_code text;
alter table utility_orders add column if not exists item_code text;
alter table utility_orders alter column operator_id drop not null;
update utility_orders set operator_code = operator_id::text where operator_code is null and operator_id is not null;

alter table saved_beneficiaries add column if not exists operator_code text;
update saved_beneficiaries set operator_code = operator_id::text where operator_code is null and operator_id is not null;
