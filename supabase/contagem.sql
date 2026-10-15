-- Onion Cost — Contagem de itens da loja (estoque)
-- Rode depois de usuarios.sql e checklist.sql. Pode rodar mais de uma vez.

-- Master, ou gerente com o módulo e a unidade
create or replace function public.app_gerencia(u uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where user_id = auth.uid() and ativo
      and (papel = 'master' or (papel = 'gerente' and m = any (modulos) and u = any (unit_ids)))
  )
$$;
revoke execute on function public.app_gerencia(uuid, text) from anon;

-- Listas de contagem (ex.: Diária – Proteínas; Semanal – Geral)
create table if not exists count_lists (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  dias_semana int[] not null default '{0,1,2,3,4,5,6}', -- 0 = domingo … 6 = sábado
  todos_itens boolean not null default false,           -- true: entra todo item ativo da unidade
  ordem int not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
alter table count_lists enable row level security;

create or replace function public.app_gerente_de(m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo
    and (papel = 'master' or (papel = 'gerente' and m = any (modulos))))
$$;
revoke execute on function public.app_gerente_de(text) from anon;

drop policy if exists "ver listas" on count_lists;
create policy "ver listas" on count_lists for select to authenticated using (app_has_module('contagem'));
drop policy if exists "cadastrar listas" on count_lists;
create policy "cadastrar listas" on count_lists for insert to authenticated with check (app_gerente_de('contagem'));
drop policy if exists "alterar listas" on count_lists;
create policy "alterar listas" on count_lists for update to authenticated using (app_gerente_de('contagem')) with check (app_gerente_de('contagem'));
drop policy if exists "apagar listas" on count_lists;
create policy "apagar listas" on count_lists for delete to authenticated using (app_gerente_de('contagem'));

insert into count_lists (nome, dias_semana, todos_itens, ordem)
select * from (values ('Diária – Proteínas', '{0,1,2,3,4,5,6}'::int[], false, 1), ('Semanal – Geral', '{1}'::int[], true, 2)) v
where not exists (select 1 from count_lists);

-- Itens que a loja conta
create table if not exists count_items (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  categoria text not null default 'Geral',        -- ex.: Congelados, Embalagens, Bebidas
  medida text not null default 'un',              -- un, kg, cx, pct, fardo…
  unit_ids uuid[] not null check (cardinality(unit_ids) > 0),
  list_ids uuid[] not null default '{}',          -- listas de contagem em que entra
  estoque_minimo numeric check (estoque_minimo >= 0),   -- abaixo disso: alerta de compra
  custo numeric check (custo >= 0),                     -- R$ por medida (valor do estoque)
  ordem int not null default 0,
  ativo boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table count_items enable row level security;

-- Quantidade contada: uma por item, unidade e dia (vale para todas as listas em que o item está)
create table if not exists counts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references count_items(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  data date not null,
  quantidade numeric not null check (quantidade >= 0),
  contado_por uuid default auth.uid() references auth.users(id) on delete set null,
  contado_por_nome text,
  contado_em timestamptz not null default now(),
  unique (item_id, unit_id, data)
);
create index if not exists counts_dia on counts (unit_id, data);
alter table counts enable row level security;

-- Itens: vê quem tem o módulo e alguma das unidades; cadastra master ou gerente das unidades
drop policy if exists "ver itens" on count_items;
create policy "ver itens" on count_items for select to authenticated
  using (app_has_module('contagem') and app_any_unit(unit_ids));
drop policy if exists "cadastrar itens" on count_items;
create policy "cadastrar itens" on count_items for insert to authenticated
  with check (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_gerencia(u, 'contagem')));
drop policy if exists "alterar itens" on count_items;
create policy "alterar itens" on count_items for update to authenticated
  using (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_gerencia(u, 'contagem')))
  with check (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_gerencia(u, 'contagem')));
drop policy if exists "apagar itens" on count_items;
create policy "apagar itens" on count_items for delete to authenticated
  using (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_gerencia(u, 'contagem')));

-- Contagens: módulo + unidade. A equipe lança/corrige só no próprio dia; gerente e master, qualquer dia
drop policy if exists "ver contagens" on counts;
create policy "ver contagens" on counts for select to authenticated
  using (app_has_module('contagem') and app_has_unit(unit_id));
drop policy if exists "lancar contagem" on counts;
create policy "lancar contagem" on counts for insert to authenticated
  with check (app_has_module('contagem') and app_has_unit(unit_id) and contado_por = auth.uid()
    and (data = (now() at time zone 'America/Sao_Paulo')::date or app_gerencia(unit_id, 'contagem')));
drop policy if exists "corrigir contagem" on counts;
create policy "corrigir contagem" on counts for update to authenticated
  using (app_has_module('contagem') and app_has_unit(unit_id)
    and (data = (now() at time zone 'America/Sao_Paulo')::date or app_gerencia(unit_id, 'contagem')))
  with check (app_has_module('contagem') and app_has_unit(unit_id) and contado_por = auth.uid()
    and (data = (now() at time zone 'America/Sao_Paulo')::date or app_gerencia(unit_id, 'contagem')));
drop policy if exists "apagar contagem" on counts;
create policy "apagar contagem" on counts for delete to authenticated
  using (app_gerencia(unit_id, 'contagem'));
