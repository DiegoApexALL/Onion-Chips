-- Guardar o XML das NFC-e emitidas e listar por mês (ações "xml-meses" / "xml-mes" da função "nfe").
-- Já aplicado no banco em 04/11/2026 (migrações 20261104183425 a 20261104183822).

alter table public.nfce_docs add column if not exists xml text;
alter table public.nfce_docs add column if not exists xml_eventos text;
create index if not exists nfce_docs_sem_xml_idx on public.nfce_docs (company_id, competencia) where xml is null;

-- Resumo mensal (só mês atual e anterior)
create or replace function public.nfce_xml_meses(p_company uuid)
returns table (competencia text, notas bigint, autorizadas bigint, canceladas bigint, valor_autorizado numeric, com_xml bigint, sem_xml bigint)
language sql stable security definer set search_path = public as $$
  select competencia,
         count(*),
         count(*) filter (where situacao = 'autorizada'),
         count(*) filter (where situacao = 'cancelada'),
         coalesce(sum(valor) filter (where situacao = 'autorizada'), 0),
         count(*) filter (where xml is not null),
         count(*) filter (where xml is null)
  from nfce_docs
  where company_id = p_company
    and competencia >= to_char((now() at time zone 'America/Sao_Paulo') - interval '1 month', 'YYYY-MM')
  group by competencia order by competencia desc
$$;
revoke all on function public.nfce_xml_meses(uuid) from public, anon, authenticated;
grant execute on function public.nfce_xml_meses(uuid) to service_role;
