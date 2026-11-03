-- Profile pictures: a small, already-resized image per user (JPEG/PNG/WebP, base64), kept out of
-- the users table so ordinary user queries never carry it.
create table if not exists user_avatars (
  user_id     uuid primary key references users(id) on delete cascade,
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  image_b64   text not null check (length(image_b64) <= 400000),
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);
alter table user_avatars enable row level security;
