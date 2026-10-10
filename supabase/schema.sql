-- NoteCode – Datenbank-Schema für die geräteübergreifende Synchronisierung.
-- Einmalig im Supabase-Dashboard unter "SQL Editor" ausführen.

create table if not exists public.arrangements (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title text not null default 'Ohne Titel',
  data jsonb not null,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create index if not exists arrangements_user_idx on public.arrangements (user_id, updated_at desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Jede Person sieht und ändert ausschließlich die eigenen Daten
alter table public.arrangements enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "eigene Arrangements" on public.arrangements;
create policy "eigene Arrangements" on public.arrangements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "eigene Einstellungen" on public.user_settings;
create policy "eigene Einstellungen" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
