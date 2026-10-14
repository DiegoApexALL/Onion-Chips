-- Onion Cost — Cadastro de Empresas e consulta de NF-e recebidas
-- Cole este arquivo em: Supabase > SQL Editor > New query > Run
-- (pode rodar mais de uma vez sem problema)

-- Empresas cadastradas (visíveis para todos que entram no app)
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  cnpj text not null unique check (cnpj ~ '^[0-9]{14}$'),
  name text not null,
  uf text not null check (uf in ('AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO')),
  -- Preenchidos pela função "nfe" (o app só lê)
  cert_subject text,
  cert_valid_until timestamptz,
  last_nsu bigint not null default 0,
  max_nsu bigint,
  last_sync_at timestamptz,
  next_sync_at timestamptz,
  last_status text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Certificado A1 (criptografado). SEM políticas de acesso: só a função "nfe" lê.
create table if not exists company_certs (
  company_id uuid primary key references companies(id) on delete cascade,
  payload text not null,
  updated_at timestamptz not null default now()
);

-- Resumo de cada NF-e recebida da SEFAZ
create table if not exists nfe_docs (
  company_id uuid not null references companies(id) on delete cascade,
  chave text not null,
  nsu bigint,
  emit_doc text,
  emit_nome text,
  dh_emi timestamptz,
  competencia text,          -- 'AAAA-MM' da data de emissão
  valor numeric,
  situacao text not null default 'autorizada', -- autorizada | denegada | cancelada
  completa boolean not null default false,     -- true quando a SEFAZ entregou o XML completo
  updated_at timestamptz not null default now(),
  primary key (company_id, chave)
);
create index if not exists nfe_docs_mes on nfe_docs (company_id, competencia);

alter table companies enable row level security;
alter table company_certs enable row level security;
alter table nfe_docs enable row level security;

drop policy if exists "logados" on companies;
create policy "logados" on companies for all to authenticated using (true) with check (true);

drop policy if exists "logados leem" on nfe_docs;
create policy "logados leem" on nfe_docs for select to authenticated using (true);
-- company_certs: nenhuma política de propósito (ninguém lê pelo app)


-- NFC-e emitidas pela empresa (serviço SAE-NFC-e da SEFAZ-SP)
alter table companies add column if not exists nfce_cursor timestamptz;
alter table companies add column if not exists nfce_next_at timestamptz;
alter table companies add column if not exists nfce_status text;
alter table companies add column if not exists nfce_sync_at timestamptz;

create table if not exists nfce_docs (
  company_id uuid not null references companies(id) on delete cascade,
  chave text not null,
  competencia text not null,          -- 'AAAA-MM' (da chave; corrigido pela data de emissão ao baixar o XML)
  dh_emi timestamptz,
  valor numeric,
  situacao text not null default 'autorizada',
  baixada boolean not null default false,
  tentativas int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (company_id, chave)
);
create index if not exists nfce_docs_mes on nfce_docs (company_id, competencia);
create index if not exists nfce_docs_pendentes on nfce_docs (company_id, baixada) where not baixada;
alter table nfce_docs enable row level security;
drop policy if exists "logados leem" on nfce_docs;
create policy "logados leem" on nfce_docs for select to authenticated using (true);

create or replace view nfce_resumo with (security_invoker = true) as
select company_id, competencia,
  count(*) filter (where situacao <> 'cancelada') as quantidade,
  count(*) filter (where situacao = 'cancelada') as canceladas,
  count(*) filter (where baixada) as baixadas,
  count(*) as total_chaves,
  coalesce(sum(valor) filter (where baixada and situacao = 'autorizada'), 0) as valor
from nfce_docs
group by company_id, competencia;
grant select on nfce_resumo to authenticated;
