# 🧅 Onion Cost

App para calcular o **custo de produção** e o **preço de venda** de produtos (ex.: onion chips).

- **Ingredientes**: cadastre o que você compra (preço pago + quantidade em g, kg, ml, L ou un). O app calcula o custo por grama/ml/unidade.
- **Receitas**: diga quanto de cada ingrediente usa no lote, quanto rende, outros custos (gás, energia, mão de obra) e a margem desejada. O app mostra custo do lote, custo por unidade, **preço sugerido** e o lucro com o preço que você pratica hoje.
- **Painel**: resumo de todas as receitas e margem média.

Feito com React + Vite. Banco de dados gratuito no **Supabase**, único e compartilhado: todos que entram (login por e-mail) veem e editam os mesmos registros, pelo site ou pelo app Android. Sem Supabase configurado, o app funciona em **modo local** (salva no navegador).

## Rodar localmente

```bash
npm install
npm run dev
```

## Configurar o banco gratuito (Supabase)

1. Crie uma conta em [supabase.com](https://supabase.com) e um projeto novo (plano Free).
2. Em **SQL Editor → New query**, cole o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Project Settings → API**, copie a *Project URL* e a chave *anon public*.
4. Coloque os dois valores em `src/lib/config.ts` (ou copie `.env.example` para `.env` e preencha):
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=...
   ```
5. (Opcional) Em **Authentication → Providers → Email**, desative *Confirm email* para entrar sem confirmar o e-mail.

## Cadastro Empresas e notas fiscais recebidas

A aba **Empresas** guarda os CNPJs das suas empresas e mostra quantas NF-e foram
emitidas contra cada um no mês corrente (notas em que a empresa é destinatária),
com o valor total. Os dados vêm direto da SEFAZ (serviço *NFeDistribuicaoDFe* do
Ambiente Nacional), usando o **certificado digital A1 (e-CNPJ)** de cada empresa.

Como funciona: o app chama a função `nfe` (Supabase Edge Function, em
`supabase/functions/nfe`). Ela guarda o certificado criptografado, consulta a SEFAZ,
salva o resumo de cada nota em `nfe_docs` e devolve o total do mês. A SEFAZ só
libera uma nova consulta 1 hora depois de responder "nenhum documento novo"; nesse
intervalo o app mostra o que já foi baixado. Na primeira consulta ela entrega as
notas dos últimos ~90 dias.

### Configurar (uma vez)

1. **Banco:** no Supabase, abra **SQL Editor → New query**, cole o conteúdo de
   [`supabase/empresas.sql`](supabase/empresas.sql) e clique em **Run**.
2. **Publicar a função pelo GitHub:** no Supabase, crie um token em
   **Account → Access Tokens** (https://supabase.com/dashboard/account/tokens).
   No GitHub, em **Settings → Secrets and variables → Actions → New repository secret**,
   crie `SUPABASE_ACCESS_TOKEN` com esse token. Depois rode o workflow
   **Função NF-e (Supabase)** em **Actions** (ele também roda sozinho quando a função muda).
3. *(Recomendado)* Em **Supabase → Edge Functions → Secrets**, crie `CERT_SECRET`
   com uma senha longa qualquer. Ela criptografa os certificados guardados.
   Se for trocar depois, envie os certificados de novo.
4. No app, abra **Empresas**, cadastre o CNPJ e a UF, toque em **Certificado** e
   envie o arquivo `.pfx` com a senha. As notas aparecem sozinhas em até 15 minutos.

### Consulta automática (GitHub Actions)

A SEFAZ pede o certificado no meio da conexão (renegociação TLS), e o ambiente do
Supabase não sabe fazer isso. Por isso a consulta roda no GitHub Actions
([`.github/workflows/sefaz-sync.yml`](.github/workflows/sefaz-sync.yml), script em
[`scripts/sefaz-sync.mjs`](scripts/sefaz-sync.mjs)) a cada 15 minutos. O workflow pede à
função `nfe` as empresas com consulta liberada, fala com a SEFAZ e devolve as respostas
para a função gravar. Não há senha: a função confere o token OIDC que o GitHub emite
para este repositório. Nada sensível aparece no log.

Observação: o GitHub pausa agendamentos de repositórios públicos sem atividade por 60
dias. Se isso acontecer, reative em **Actions → Notas fiscais (SEFAZ) → Enable workflow**.

## Publicar grátis (Vercel ou Netlify)

1. Importe este repositório na [Vercel](https://vercel.com) ou [Netlify](https://netlify.com).
2. Build command: `npm run build` · Output: `dist`.
3. Adicione as variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` nas configurações do projeto.

## App Android

O projeto Android fica em `android/` (Capacitor). A cada push, o GitHub Actions
(`.github/workflows/android.yml`) gera o `OnionCost.apk` e publica em
**Releases** — abra `https://github.com/DiegoApexALL/Onion-Chips/releases/latest`
no celular para baixar e instalar. No app, os dados ficam salvos no próprio celular.

Para gerar localmente (precisa do Android SDK): `npm run build && npx cap sync android && cd android && ./gradlew assembleRelease`.
