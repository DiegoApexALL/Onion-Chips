-- ABANDONADO em 06/11/2026: o app não guarda mais o XML das NFC-e (a função "nfe" voltou à versão
-- anterior, que só registra valor, data e situação). Este SQL continua aqui só porque já foi aplicado
-- no banco em 04/11/2026 (migrações 20261104183425 a 20261104183822): as colunas xml/xml_eventos e a
-- função nfce_xml_meses ainda existem, mas nada usa. Não aplicar de novo em banco novo.

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
