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

-- Ingredientes viram itens da contagem (dois checks no cadastro do ingrediente)
alter table ingredients add column if not exists contar_diaria boolean not null default false;
alter table ingredients add column if not exists contar_semanal boolean not null default true;
alter table count_items add column if not exists ingredient_id uuid unique references ingredients(id) on delete cascade;
alter table count_lists add column if not exists chave text unique;   -- 'diaria' = lista do check "contagem diária"
update count_lists set chave = 'diaria' where nome = 'Diária – Proteínas' and chave is null;

create or replace function public.sync_ingrediente_contagem() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  med text := case new.unit when 'g' then 'kg' when 'kg' then 'kg' when 'ml' then 'L' when 'l' then 'L' else 'un' end;
  fator numeric := case new.unit when 'g' then 1000 when 'ml' then 1000 else 1 end;
  custo_med numeric := round(new.package_price / nullif(new.package_qty, 0) * fator, 4);
  diaria uuid := (select id from count_lists where chave = 'diaria');
  mudou boolean := tg_op = 'INSERT' or old.contar_diaria is distinct from new.contar_diaria or old.contar_semanal is distinct from new.contar_semanal;
begin
  if not exists (select 1 from count_items where ingredient_id = new.id) then
    if new.contar_semanal or new.contar_diaria then
      insert into count_items (ingredient_id, nome, categoria, medida, custo, unit_ids, list_ids, ativo)
      values (new.id, new.name, 'Ingredientes', med, custo_med, coalesce((select array_agg(id) from units), '{}'),
              case when new.contar_diaria and diaria is not null then array[diaria] else '{}' end, true);
    end if;
    return new;
  end if;
  update count_items c set
    nome = new.name,
    custo = case when c.medida = med then custo_med else c.custo end,
    ativo = case when mudou then (new.contar_semanal or new.contar_diaria) else c.ativo end,
    list_ids = case
      when not mudou or diaria is null then c.list_ids
      when new.contar_diaria then array(select distinct x from unnest(c.list_ids || diaria) x)
      else array_remove(c.list_ids, diaria) end
  where c.ingredient_id = new.id;
  return new;
end $$;
revoke execute on function public.sync_ingrediente_contagem() from public, anon, authenticated;

drop trigger if exists ingrediente_contagem on ingredients;
create trigger ingrediente_contagem after insert or update on ingredients
  for each row execute function sync_ingrediente_contagem();

-- Cria os itens dos ingredientes que já existem (precisa ter unidades cadastradas)
update ingredients set contar_semanal = contar_semanal where exists (select 1 from units)
  and not exists (select 1 from count_items c where c.ingredient_id = ingredients.id);
