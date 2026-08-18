-- Настоящая авторизация через Supabase Auth (запустить в SQL Editor)

-- 1. Колонка user_id в markers (uuid от Supabase Auth)
alter table public.markers add column if not exists user_id uuid;

-- 2. Профили: user_id -> никнейм
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null
);
alter table public.profiles enable row level security;
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select using (true);
drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = user_id);
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles for update using (auth.uid() = user_id);

-- 3. RLS markers: читать всем, писать/менять/удалять только своим
drop policy if exists "public_read" on public.markers;
drop policy if exists "public_insert" on public.markers;
drop policy if exists "public_update" on public.markers;
drop policy if exists "public_delete" on public.markers;
drop policy if exists "markers_select" on public.markers;
drop policy if exists "markers_insert" on public.markers;
drop policy if exists "markers_update" on public.markers;
drop policy if exists "markers_delete" on public.markers;

create policy "markers_select" on public.markers for select using (true);
create policy "markers_insert" on public.markers for insert with check (auth.uid() = user_id);
create policy "markers_update" on public.markers for update using (auth.uid() = user_id);
create policy "markers_delete" on public.markers for delete using (auth.uid() = user_id);

-- 4. Старую самописную таблицу users больше не используем — удаляем
drop table if exists public.users;
