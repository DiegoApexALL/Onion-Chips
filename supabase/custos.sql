-- Onion Cost — Custos fixos e variáveis de cada empresa (aba Empresas)
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run
-- (pode rodar mais de uma vez sem problema). Precisa de empresas.sql e usuarios.sql antes.

create table if not exists company_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  tipo text not null check (tipo in ('fixo', 'variavel')),
  descricao text not null check (length(trim(descricao)) > 0),
  categoria text not null default 'Outros',
  valor numeric not null check (valor >= 0),
  -- Custo variável pode ser em R$ por mês ou em % do faturamento (ex.: taxa de cartão, iFood, imposto)
  unidade text not null default 'reais' check (unidade in ('reais', 'percentual')),
  -- Custo fixo: mensal ou anual (o anual entra no mês dividido por 12)
  periodicidade text not null default 'mensal' check (periodicidade in ('mensal', 'anual')),
  vencimento_dia int check (vencimento_dia between 1 and 31),
  fornecedor text,
  observacao text,
  ativo boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (unidade = 'reais' or (tipo = 'variavel' and valor <= 100))
);
create index if not exists company_costs_empresa on company_costs (company_id, tipo);

alter table company_costs enable row level security;
drop policy if exists "notas" on company_costs;
create policy "notas" on company_costs for all to authenticated
  using (app_has_module('notas')) with check (app_has_module('notas'));
