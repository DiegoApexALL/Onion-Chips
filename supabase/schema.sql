-- Onion Cost — esquema do banco (Supabase / Postgres)
-- Banco ÚNICO e compartilhado: toda pessoa que entrar no app (com login) vê e edita os mesmos registros.
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run

create table if not exists ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null check (unit in ('g','kg','ml','l','un')),
  package_price numeric not null check (package_price >= 0),
  package_qty numeric not null check (package_qty > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  yield_qty numeric not null check (yield_qty > 0),
  yield_label text not null default 'pacotes',
  extra_costs numeric not null default 0,
  margin_pct numeric not null default 100,
  sale_price numeric,
  notes text,
  items jsonb not null default '[]'::jsonb, -- [{ingredient_id, quantity, unit}]
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Uma única linha de configurações (meta de CMV) para todos
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  cmv_min numeric not null default 30,
  cmv_max numeric not null default 40
);
insert into settings (id) values (1) on conflict (id) do nothing;

alter table ingredients enable row level security;
alter table recipes enable row level security;
alter table settings enable row level security;

-- Só quem está logado lê e grava; quem não entrou não vê nada
drop policy if exists "logados" on ingredients;
create policy "logados" on ingredients for all to authenticated using (true) with check (true);

drop policy if exists "logados" on recipes;
create policy "logados" on recipes for all to authenticated using (true) with check (true);

drop policy if exists "logados" on settings;
create policy "logados" on settings for all to authenticated using (true) with check (true);
