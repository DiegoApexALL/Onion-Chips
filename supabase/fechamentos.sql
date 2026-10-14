-- Onion Cost — Fechamento de caixa por unidade
-- Cole em: Supabase > SQL Editor > New query > Run (pode rodar mais de uma vez)

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cidade text not null default '',
  apelidos text,                                   -- nomes/CNPJ (raiz) que aparecem nos comprovantes, separados por vírgula
  company_id uuid references companies(id) on delete set null, -- empresa (CNPJ) para cruzar com as notas fiscais
  created_at timestamptz not null default now()
);
alter table units enable row level security;
drop policy if exists "logados" on units;
create policy "logados" on units for all to authenticated using (true) with check (true);

-- Um fechamento por unidade e por dia
create table if not exists cash_closings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  data date not null,
  abertura_at timestamp,
  fechamento_at timestamp,
  responsavel text,
  vendas_qtd int not null default 0,
  vendas_total numeric not null default 0,
  valor_abertura numeric not null default 0,
  sistema jsonb not null default '{}'::jsonb,      -- {dinheiro, debito, credito, outros, pix} apurado pelo PDV
  contado jsonb not null default '{}'::jsonb,      -- o mesmo, apurado pelo responsável
  maquininhas jsonb not null default '[]'::jsonb,  -- [{nome, debito, credito, pix}]
  delivery jsonb not null default '[]'::jsonb,     -- [{canal, pedidos, valor}]
  despesas jsonb not null default '[]'::jsonb,     -- [{descricao, valor}]
  repasse numeric not null default 0,
  troco numeric not null default 0,
  observacoes text,
  texto_original text,                             -- texto colado da Meta AI
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, data)
);
create index if not exists cash_closings_data on cash_closings (data);
alter table cash_closings enable row level security;
drop policy if exists "logados" on cash_closings;
create policy "logados" on cash_closings for all to authenticated using (true) with check (true);
