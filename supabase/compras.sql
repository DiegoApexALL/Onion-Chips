-- Onion Cost — Itens das notas de compra (NF-e) e preço dos ingredientes atualizado pelas compras
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run
-- (pode rodar mais de uma vez sem problema). Precisa de schema.sql, empresas.sql e usuarios.sql antes.

-- Itens de cada NF-e recebida (preenchido pela função "nfe" a partir do XML completo)
create table if not exists nfe_items (
  company_id uuid not null,
  chave text not null,
  n_item int not null,
  emit_doc text,
  emit_nome text,
  dh_emi timestamptz,
  competencia text,
  codigo text,              -- código do produto no fornecedor (cProd)
  ean text,
  descricao text not null,  -- xProd
  ncm text,
  cfop text,
  unidade text,             -- unidade comercial (uCom): CX, KG, UN, FD…
  quantidade numeric,       -- qCom
  valor_unit numeric,       -- vUnCom
  valor_total numeric,      -- vProd
  desconto numeric not null default 0,
  primary key (company_id, chave, n_item),
  foreign key (company_id, chave) references nfe_docs (company_id, chave) on delete cascade
);
create index if not exists nfe_items_produto on nfe_items (emit_doc, codigo, dh_emi desc);
create index if not exists nfe_items_mes on nfe_items (company_id, competencia);

-- Produto do fornecedor -> ingrediente. fator = quanto 1 unidade da nota vale na unidade do ingrediente
-- (ex.: 1 CX = 20 kg -> fator 20, se o ingrediente é em kg)
create table if not exists ingredient_links (
  id uuid primary key default gen_random_uuid(),
  emit_doc text not null,
  codigo text not null,
  descricao text,
  ingredient_id uuid not null references ingredients (id) on delete cascade,
  fator numeric not null check (fator > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (emit_doc, codigo)
);
create index if not exists ingredient_links_ing on ingredient_links (ingredient_id);

-- Histórico de preço de cada ingrediente (uma linha por compra vinculada)
create table if not exists ingredient_prices (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredients (id) on delete cascade,
  company_id uuid,
  chave text,
  n_item int,
  dh_emi timestamptz,
  emit_nome text,
  package_price numeric not null,
  package_qty numeric not null,
  created_at timestamptz not null default now(),
  unique (ingredient_id, chave, n_item)
);
create index if not exists ingredient_prices_ing on ingredient_prices (ingredient_id, dh_emi desc);

alter table ingredients add column if not exists last_purchase_at timestamptz;
alter table ingredients add column if not exists last_purchase_emit text;

-- Funções internas ficam no schema private (fora da API pública)
create schema if not exists private;

-- Aplica um item de nota a um ingrediente: grava o histórico e, se for a compra mais recente, atualiza o custo
create or replace function private.apply_purchase(i nfe_items, l ingredient_links) returns void
language plpgsql security definer set search_path = public as $$
declare
  unit_cost numeric;
begin
  if coalesce(i.quantidade, 0) <= 0 then return; end if;
  if exists (select 1 from nfe_docs d where d.company_id = i.company_id and d.chave = i.chave and d.situacao <> 'autorizada') then
    return;
  end if;
  unit_cost := round((coalesce(i.valor_total, i.valor_unit * i.quantidade) - coalesce(i.desconto, 0)) / i.quantidade, 4);
  insert into ingredient_prices (ingredient_id, company_id, chave, n_item, dh_emi, emit_nome, package_price, package_qty)
  values (l.ingredient_id, i.company_id, i.chave, i.n_item, i.dh_emi, i.emit_nome, unit_cost, l.fator)
  on conflict (ingredient_id, chave, n_item) do update set package_price = excluded.package_price, package_qty = excluded.package_qty;
  update ingredients set package_price = unit_cost, package_qty = l.fator,
    last_purchase_at = i.dh_emi, last_purchase_emit = i.emit_nome
  where id = l.ingredient_id and (last_purchase_at is null or i.dh_emi >= last_purchase_at);
end $$;

-- Item novo na nota: se o produto já está vinculado, atualiza o ingrediente
create or replace function private.trg_nfe_item_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare l ingredient_links;
begin
  select * into l from ingredient_links where emit_doc = new.emit_doc and codigo = new.codigo;
  if found then perform private.apply_purchase(new, l); end if;
  return new;
end $$;
create or replace trigger nfe_item_price after insert on nfe_items for each row execute function private.trg_nfe_item_price();

-- Vínculo novo ou alterado: aplica todas as compras já baixadas desse produto
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
  for i in select * from nfe_items where emit_doc = new.emit_doc and codigo = new.codigo order by dh_emi loop
    perform private.apply_purchase(i, new);
  end loop;
  return new;
end $$;
create or replace trigger link_price after insert or update on ingredient_links for each row execute function private.trg_link_price();

-- Desvincular: tira do histórico as compras desse produto
create or replace function private.trg_unlink_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from ingredient_prices p using nfe_items x
  where p.ingredient_id = old.ingredient_id and x.chave = p.chave and x.n_item = p.n_item
    and x.emit_doc = old.emit_doc and x.codigo = old.codigo;
  return old;
end $$;
create or replace trigger unlink_price after delete on ingredient_links for each row execute function private.trg_unlink_price();


alter table nfe_items enable row level security;
alter table ingredient_links enable row level security;
alter table ingredient_prices enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nfe_items' and policyname = 'notas ou custos') then
    create policy "notas ou custos" on nfe_items for select to authenticated
  using (app_has_module('notas') or app_has_module('custos'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ingredient_links' and policyname = 'custos') then
    create policy "custos" on ingredient_links for all to authenticated
  using (app_has_module('custos')) with check (app_has_module('custos'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ingredient_prices' and policyname = 'custos') then
    create policy "custos" on ingredient_prices for select to authenticated using (app_has_module('custos'));
  end if;
end $$;
