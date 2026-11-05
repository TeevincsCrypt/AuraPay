-- Transfers can now be POL (Polygon's native coin) and can go to any address, not only to an
-- @username. A transfer to an address that isn't an AuraPay user has no recipient user.
alter table transfers alter column to_user_id drop not null;
alter table transfers drop constraint if exists transfers_currency_check;
alter table transfers add constraint transfers_currency_check check (currency in ('NIM', 'USDT', 'POL'));
