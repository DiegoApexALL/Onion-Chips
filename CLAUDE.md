# Onion Cost — mapa do projeto

**Este repositório é a fonte única da verdade.** Tudo do Onion Cost (app, funções do Supabase, SQL do banco,
workflows) fica aqui. Nada deve ser alterado direto no Supabase ou em artifacts sem voltar para cá.

## Onde está cada coisa

| O quê | Onde |
|---|---|
| Código do app (React + Vite + Capacitor) | `src/` (páginas em `src/pages/`) |
| Branch principal | `claude/onion-cost-app-clone-qdy4s1` (é a branch que publica e que o GitHub OIDC da função `nfe` aceita) |
| Site publicado | branch `gh-pages` (workflow `.github/workflows/web.yml`) |
| App Android | workflow `.github/workflows/android.yml`, versões marcadas com tags `android-vNN` |
| Banco em uso | Supabase **onion-cost** — ref `nzyicmdfzjhmlijoocdv` (sa-east-1), URL em `src/lib/config.ts` |
| Funções do Supabase | `supabase/functions/nfe`, `supabase/functions/admin-users`, `supabase/functions/fechamento-whatsapp` |
| Deploy das funções | `.github/workflows/supabase.yml` (precisa do segredo `SUPABASE_ACCESS_TOKEN`) |
| SQL do banco | `supabase/*.sql` (`schema.sql` primeiro, depois um arquivo por módulo) |
| Sincronização SEFAZ (NF-e / NFC-e) | `.github/workflows/sefaz-sync.yml` + função `nfe` |

Projetos antigos no Supabase, **não usar**: `Onion Cost` (lvawsrspwnpnhorlyvdo), `Lista Onion`
(lyjnzyhsnpgaykeeryba), `Gerencial OC` (qpnlpgoyrbuvhmtfojzr) — todos inativos.
O artifact "Onion Cost" no Claude (out/2026) é uma versão antiga e não é mais atualizado.

## Módulos do app

Ingredientes, Receitas, Painel, Delivery (taxas por canal e preço sugerido por app), Empresas / notas
fiscais (total de NF-e recebidas contra o CNPJ e de NFC-e emitidas na SEFAZ-SP — sem guardar XML), Fechamentos de caixa (pelo app ou pelo WhatsApp),
Checklist com foto, Contagem diária/semanal, Usuários e permissões (master, gerente, equipe).

## Regras para manter tudo atualizado

1. **Toda mudança entra por aqui**: branch nova a partir da principal → PR → merge.
2. **Mudou o banco?** Além de aplicar no Supabase, salve o SQL em `supabase/<modulo>.sql`.
3. **Mudou uma função?** Edite em `supabase/functions/<nome>` e deixe o workflow publicar.
   Não edite direto pelo painel do Supabase.
4. Antes de começar qualquer trabalho, confira se o Supabase não tem algo mais novo que o repositório
   (lista de migrações e versão das funções) e traga para cá primeiro.
5. Atualize este arquivo quando surgir módulo, função ou projeto novo.

## Histórico de sincronização

- **06/11/2026** — trazidos do Supabase para o repositório: função `fechamento-whatsapp` (29/10),
  e o SQL das migrações de 29/10 e 04/11 (`supabase/whatsapp.sql`, `supabase/nfce_xml.sql`).
  A tela do app para ver as mensagens do WhatsApp ainda não existe no repositório.
- **06/11/2026** — **guardar o XML das NFC-e foi abandonado.** A função `nfe` voltou à versão anterior
  a 04/11: só consulta as NF-e emitidas contra o CNPJ e o valor/situação das NFC-e emitidas.
  A versão com XML (v7, no ar de 04/11 a 06/11) fazia cada rodada da SEFAZ passar de 5 min e o
  token OIDC do GitHub vencia no meio, então a sincronização falhou de 04/11 15h46 até a volta.
  As colunas `nfce_docs.xml`/`xml_eventos` e a função `nfce_xml_meses` continuam no banco sem uso.
