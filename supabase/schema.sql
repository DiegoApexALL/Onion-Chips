-- Onion Cost — esquema do banco (Supabase / Postgres)
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run

create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  unit text not null check (unit in ('g','kg','ml','l','un')),
  package_price numeric not null check (package_price >= 0),
  package_qty numeric not null check (package_qty > 0),
  created_at timestamptz not null default now()
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  yield_qty numeric not null check (yield_qty > 0),
  yield_label text not null default 'pacotes',
  extra_costs numeric not null default 0,
  margin_pct numeric not null default 100,
  sale_price numeric,
  notes text,
  items jsonb not null default '[]'::jsonb, -- [{ingredient_id, quantity, unit}]
  created_at timestamptz not null default now()
);

alter table ingredients enable row level security;
alter table recipes enable row level security;

drop policy if exists "own ingredients" on ingredients;
create policy "own ingredients" on ingredients
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own recipes" on recipes;
create policy "own recipes" on recipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
