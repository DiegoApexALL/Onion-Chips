-- Onion Cost — usuários, perfis e permissões
-- Cada pessoa logada precisa de um perfil ativo; sem perfil, o banco não entrega nada.
-- Módulos: custos (ingredientes/receitas/painel), fechamentos, notas (empresas e NF-e/NFC-e),
--          contagem, checklist. O master vê tudo e é o único que gerencia usuários e unidades.

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  login text unique,
  papel text not null default 'equipe' check (papel in ('master', 'gerente', 'equipe')),
  modulos text[] not null default '{}',
  unit_ids uuid[] not null default '{}',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

create or replace function public.app_is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo and papel = 'master')
$$;
create or replace function public.app_has_module(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo and (papel = 'master' or m = any (modulos)))
$$;
create or replace function public.app_has_unit(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo and (papel = 'master' or u = any (unit_ids)))
$$;
revoke execute on function public.app_is_master(), public.app_has_module(text), public.app_has_unit(uuid) from anon;

drop policy if exists "proprio ou master" on profiles;
create policy "proprio ou master" on profiles for select to authenticated using (user_id = auth.uid() or app_is_master());
drop policy if exists "master gerencia" on profiles;
create policy "master gerencia" on profiles for all to authenticated using (app_is_master()) with check (app_is_master());

-- Custos
drop policy if exists "logados" on ingredients;
drop policy if exists "custos" on ingredients;
create policy "custos" on ingredients for all to authenticated using (app_has_module('custos')) with check (app_has_module('custos'));
drop policy if exists "logados" on recipes;
drop policy if exists "custos" on recipes;
create policy "custos" on recipes for all to authenticated using (app_has_module('custos')) with check (app_has_module('custos'));
drop policy if exists "logados" on settings;
drop policy if exists "custos" on settings;
create policy "custos" on settings for all to authenticated using (app_has_module('custos')) with check (app_has_module('custos'));

-- Notas fiscais
drop policy if exists "logados" on companies;
drop policy if exists "notas" on companies;
create policy "notas" on companies for all to authenticated using (app_has_module('notas')) with check (app_has_module('notas'));
drop policy if exists "logados leem" on nfe_docs;
drop policy if exists "notas" on nfe_docs;
create policy "notas" on nfe_docs for select to authenticated using (app_has_module('notas'));
drop policy if exists "logados leem" on nfce_docs;
drop policy if exists "notas" on nfce_docs;
create policy "notas" on nfce_docs for select to authenticated using (app_has_module('notas'));

-- Unidades: cada um vê as suas; só o master altera
drop policy if exists "logados" on units;
drop policy if exists "ver as suas" on units;
create policy "ver as suas" on units for select to authenticated using (app_has_unit(id));
drop policy if exists "master altera" on units;
create policy "master altera" on units for all to authenticated using (app_is_master()) with check (app_is_master());

-- Fechamentos: módulo + unidade
drop policy if exists "logados" on cash_closings;
drop policy if exists "fechamentos" on cash_closings;
create policy "fechamentos" on cash_closings for all to authenticated
  using (app_has_module('fechamentos') and app_has_unit(unit_id))
  with check (app_has_module('fechamentos') and app_has_unit(unit_id));

-- Quem já usava o app antes desta mudança vira master
insert into profiles (user_id, nome, papel, modulos)
select id, coalesce(split_part(email, '@', 1), 'Master'), 'master', array['custos', 'fechamentos', 'notas', 'contagem', 'checklist']
from auth.users
where not exists (select 1 from profiles)
on conflict (user_id) do nothing;
