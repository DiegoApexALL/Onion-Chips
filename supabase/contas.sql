-- Onion Cost — Contas separadas (cada dono vê só os próprios dados)
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run. Precisa de todos os outros .sql antes.
--
-- Cada usuário pertence a uma conta (profiles.conta_id). Empresas, unidades, ingredientes, receitas,
-- configurações, listas/itens de contagem, tarefas do checklist e vínculos de compra têm conta_id;
-- o resto (notas, fechamentos, contagens, custos…) segue a empresa/unidade/ingrediente de que faz parte.
-- O master só enxerga e gerencia a própria conta. Quem tem profiles.admin_sistema cria contas novas
-- (função admin-users, ação "create-conta").

-- ---------- Contas ----------
create table if not exists contas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  whatsapp boolean not null default false, -- conta dona do robô de fechamento pelo WhatsApp
  created_at timestamptz not null default now()
);
alter table contas enable row level security;
insert into contas (nome, whatsapp) select 'Onion (Diego)', true where not exists (select 1 from contas);

alter table profiles add column if not exists conta_id uuid references contas (id);
alter table profiles add column if not exists admin_sistema boolean not null default false;
update profiles set conta_id = (select id from contas order by created_at limit 1) where conta_id is null;
update profiles set admin_sistema = true
  where user_id = (select id from auth.users where email = 'diegaoata@gmail.com') and not admin_sistema;
alter table profiles alter column conta_id set not null;

create or replace function public.app_conta() returns uuid
language sql stable security definer set search_path = public as $$
  select conta_id from profiles where user_id = auth.uid() and ativo
$$;
create or replace function public.app_admin_sistema() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo and papel = 'master' and admin_sistema)
$$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contas' and policyname = 'ver contas') then
    create policy "ver contas" on contas for select to authenticated using (id = app_conta() or app_admin_sistema());
  end if;
end $$;

-- ---------- conta_id nas tabelas principais (dados atuais ficam na primeira conta) ----------
do $$
declare
  t text;
  c uuid := (select id from contas order by created_at limit 1);
begin
  foreach t in array array['companies', 'units', 'ingredients', 'recipes', 'settings', 'count_lists', 'count_items',
                           'checklist_items', 'ingredient_links', 'whatsapp_mensagens'] loop
    execute format('alter table %I add column if not exists conta_id uuid references contas (id)', t);
    execute format('update %I set conta_id = %L where conta_id is null', t, c);
    execute format('alter table %I alter column conta_id set default app_conta()', t);
    if t <> 'whatsapp_mensagens' then
      execute format('alter table %I alter column conta_id set not null', t);
    end if;
    execute format('create index if not exists %I on %I (conta_id)', t || '_conta', t);
  end loop;
end $$;

-- Configurações: uma linha por conta
create sequence if not exists settings_id_seq start 100;
alter table settings alter column id set default nextval('settings_id_seq');
create unique index if not exists settings_por_conta on settings (conta_id);

-- Unicidades que passam a valer por conta (as globais antigas são removidas no fim deste arquivo)
create unique index if not exists ingredient_links_por_conta on ingredient_links (conta_id, emit_doc, codigo);
create unique index if not exists count_lists_chave_por_conta on count_lists (conta_id, chave);

-- ---------- Funções de permissão: unidades só da própria conta ----------
create or replace function public.app_has_unit(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join units un on un.id = u and un.conta_id = p.conta_id
    where p.user_id = auth.uid() and p.ativo and (p.papel = 'master' or u = any (p.unit_ids))
  )
$$;
create or replace function public.app_any_unit(us uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join units un on un.id = any (us) and un.conta_id = p.conta_id
    where p.user_id = auth.uid() and p.ativo and (p.papel = 'master' or un.id = any (p.unit_ids))
  )
$$;
create or replace function public.app_can_manage(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join units un on un.id = u and un.conta_id = p.conta_id
    where p.user_id = auth.uid() and p.ativo
      and (p.papel = 'master' or (p.papel = 'gerente' and 'checklist' = any (p.modulos) and u = any (p.unit_ids)))
  )
$$;
create or replace function public.app_gerencia(u uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p join units un on un.id = u and un.conta_id = p.conta_id
    where p.user_id = auth.uid() and p.ativo
      and (p.papel = 'master' or (p.papel = 'gerente' and m = any (p.modulos) and u = any (p.unit_ids)))
  )
$$;
create or replace function public.app_company(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from companies where id = c and conta_id = app_conta())
$$;
create or replace function public.app_ingredient(i uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from ingredients where id = i and conta_id = app_conta())
$$;

-- ---------- Regras de acesso (RLS) por conta ----------
alter policy "logados" on companies using (app_has_module('notas') and conta_id = app_conta())
  with check (app_has_module('notas') and conta_id = app_conta());
alter policy "notas" on company_costs using (app_has_module('notas') and app_company(company_id))
  with check (app_has_module('notas') and app_company(company_id));
alter policy "logados leem" on nfe_docs using (app_has_module('notas') and app_company(company_id));
alter policy "logados leem" on nfce_docs using (app_has_module('notas') and app_company(company_id));
alter policy "notas ou custos" on nfe_items using ((app_has_module('notas') or app_has_module('custos')) and app_company(company_id));

alter policy "logados" on ingredients using (app_has_module('custos') and conta_id = app_conta())
  with check (app_has_module('custos') and conta_id = app_conta());
alter policy "logados" on recipes using (app_has_module('custos') and conta_id = app_conta())
  with check (app_has_module('custos') and conta_id = app_conta());
alter policy "logados" on settings using (app_has_module('custos') and conta_id = app_conta())
  with check (app_has_module('custos') and conta_id = app_conta());
alter policy "custos" on ingredient_links using (app_has_module('custos') and conta_id = app_conta())
  with check (app_has_module('custos') and conta_id = app_conta() and app_ingredient(ingredient_id));
alter policy "custos" on ingredient_prices using (app_has_module('custos') and app_ingredient(ingredient_id));

alter policy "proprio ou master" on profiles using (user_id = auth.uid() or (app_is_master() and conta_id = app_conta()));
alter policy "master gerencia" on profiles using (app_is_master() and conta_id = app_conta())
  with check (app_is_master() and conta_id = app_conta());

alter policy "logados" on units using (app_has_unit(id)) with check (app_is_master() and conta_id = app_conta());
alter policy "so master apaga" on units using (app_is_master() and conta_id = app_conta());

alter policy "ver tarefas" on checklist_items using (conta_id = app_conta() and app_has_module('checklist') and app_any_unit(unit_ids));
alter policy "cadastrar tarefas" on checklist_items with check (conta_id = app_conta() and cardinality(unit_ids) > 0
  and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_can_manage(u.u))));
alter policy "alterar tarefas" on checklist_items
  using (conta_id = app_conta() and (app_is_master() or (cardinality(unit_ids) > 0
    and not exists (select 1 from unnest(unit_ids) u(u) where not app_can_manage(u.u)))))
  with check (conta_id = app_conta() and cardinality(unit_ids) > 0
    and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_can_manage(u.u))));
alter policy "apagar tarefas" on checklist_items
  using (conta_id = app_conta() and (app_is_master() or (cardinality(unit_ids) > 0
    and not exists (select 1 from unnest(unit_ids) u(u) where not app_can_manage(u.u)))));

alter policy "ver itens" on count_items using (conta_id = app_conta() and app_has_module('contagem') and app_any_unit(unit_ids));
alter policy "cadastrar itens" on count_items with check (conta_id = app_conta()
  and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_gerencia(u.u, 'contagem'))));
alter policy "alterar itens" on count_items
  using (conta_id = app_conta() and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_gerencia(u.u, 'contagem'))))
  with check (conta_id = app_conta() and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_gerencia(u.u, 'contagem'))));
alter policy "apagar itens" on count_items
  using (conta_id = app_conta() and (app_is_master() or not exists (select 1 from unnest(unit_ids) u(u) where not app_gerencia(u.u, 'contagem'))));

alter policy "ver listas" on count_lists using (conta_id = app_conta() and app_has_module('contagem'));
alter policy "cadastrar listas" on count_lists with check (conta_id = app_conta() and app_gerente_de('contagem'));
alter policy "alterar listas" on count_lists using (conta_id = app_conta() and app_gerente_de('contagem'))
  with check (conta_id = app_conta() and app_gerente_de('contagem'));
alter policy "apagar listas" on count_lists using (conta_id = app_conta() and app_gerente_de('contagem'));

alter policy "logados leem mensagens whatsapp" on whatsapp_mensagens
  using (conta_id = app_conta() and app_has_module('fechamentos'));
-- cash_closings, counts, checklist_done e as fotos do checklist já dependem de app_has_unit (agora por conta)

-- ---------- Gatilhos que olhavam o sistema inteiro ----------
create or replace function public.sync_ingrediente_contagem() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  med text := case new.unit when 'g' then 'kg' when 'kg' then 'kg' when 'ml' then 'L' when 'l' then 'L' else 'un' end;
  fator numeric := case new.unit when 'g' then 1000 when 'ml' then 1000 else 1 end;
  custo_med numeric := round(new.package_price / nullif(new.package_qty, 0) * fator, 4);
  diaria uuid := (select id from count_lists where chave = 'diaria' and conta_id = new.conta_id);
  mudou boolean := tg_op = 'INSERT' or old.contar_diaria is distinct from new.contar_diaria or old.contar_semanal is distinct from new.contar_semanal;
begin
  if not exists (select 1 from count_items where ingredient_id = new.id) then
    if new.contar_semanal or new.contar_diaria then
      insert into count_items (conta_id, ingredient_id, nome, categoria, medida, custo, unit_ids, list_ids, ativo)
      values (new.conta_id, new.id, new.name, 'Ingredientes', med, custo_med,
              coalesce((select array_agg(id) from units where conta_id = new.conta_id), '{}'),
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

-- Compra nova: só o vínculo da mesma conta da empresa que comprou
create or replace function private.trg_nfe_item_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare l ingredient_links;
begin
  select k.* into l from ingredient_links k join companies c on c.id = new.company_id and c.conta_id = k.conta_id
  where k.emit_doc = new.emit_doc and k.codigo = new.codigo;
  if found then perform private.apply_purchase(new, l); end if;
  return new;
end $$;

-- Vínculo novo/alterado: só as compras das empresas da mesma conta
create or replace function private.trg_link_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare i nfe_items;
begin
  if tg_op = 'UPDATE' then
    delete from ingredient_prices p using nfe_items x
    where p.ingredient_id = old.ingredient_id and x.chave = p.chave and x.n_item = p.n_item
      and x.emit_doc = old.emit_doc and x.codigo = old.codigo;
    if old.ingredient_id <> new.ingredient_id then
      update ingredients set last_purchase_at = null where id = old.ingredient_id;
    end if;
    update ingredients set last_purchase_at = null where id = new.ingredient_id;
  end if;
  for i in
    select x.* from nfe_items x join companies c on c.id = x.company_id and c.conta_id = new.conta_id
    where x.emit_doc = new.emit_doc and x.codigo = new.codigo order by x.dh_emi
  loop
    perform private.apply_purchase(i, new);
  end loop;
  return new;
end $$;

-- ---------- Unicidades antigas (globais) que agora valem por conta ----------
alter table ingredient_links drop constraint if exists ingredient_links_emit_doc_codigo_key;
alter table count_lists drop constraint if exists count_lists_chave_key;
alter table settings drop constraint if exists settings_id_check; -- era só id = 1 (uma linha no sistema todo)
