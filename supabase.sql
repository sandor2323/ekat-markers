-- Таблица меток для карты (запустить в SQL Editor в Supabase)

create table if not exists public.markers (
  id text primary key,
  lat double precision not null,
  lng double precision not null,
  text text not null default '',
  status text not null default 'active',
  expires_at bigint not null,
  created_at bigint not null
);

alter table public.markers enable row level security;

-- Публичный доступ: все могут читать и писать (метки без авторизации)
drop policy if exists "public_read" on public.markers;
create policy "public_read" on public.markers for select using (true);

drop policy if exists "public_insert" on public.markers;
create policy "public_insert" on public.markers for insert with check (true);

drop policy if exists "public_update" on public.markers;
create policy "public_update" on public.markers for update using (true);

drop policy if exists "public_delete" on public.markers;
create policy "public_delete" on public.markers for delete using (true);
