-- Дополнительные таблицы для авторизации (запустить в SQL Editor в Supabase)

-- Пользователи (никнейм + пароль)
create table if not exists public.users (
  name text primary key,
  pass text not null
);

alter table public.users enable row level security;

drop policy if exists "public_users_read" on public.users;
create policy "public_users_read" on public.users for select using (true);

drop policy if exists "public_users_insert" on public.users;
create policy "public_users_insert" on public.users for insert with check (true);

-- Колонка автора метки
alter table public.markers add column if not exists created_by text not null default '';
