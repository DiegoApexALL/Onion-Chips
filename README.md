# 🧅 Onion Cost

App para calcular o **custo de produção** e o **preço de venda** de produtos (ex.: onion chips).

- **Ingredientes**: cadastre o que você compra (preço pago + quantidade em g, kg, ml, L ou un). O app calcula o custo por grama/ml/unidade.
- **Receitas**: diga quanto de cada ingrediente usa no lote, quanto rende, outros custos (gás, energia, mão de obra) e a margem desejada. O app mostra custo do lote, custo por unidade, **preço sugerido** e o lucro com o preço que você pratica hoje.
- **Painel**: resumo de todas as receitas e margem média.

Feito com React + Vite. Banco de dados gratuito no **Supabase** (com login por e-mail e cada usuário vendo só os próprios dados). Sem Supabase configurado, o app funciona em **modo local** (salva no navegador).

## Rodar localmente

```bash
npm install
npm run dev
```

## Configurar o banco gratuito (Supabase)

1. Crie uma conta em [supabase.com](https://supabase.com) e um projeto novo (plano Free).
2. Em **SQL Editor → New query**, cole o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Project Settings → API**, copie a *Project URL* e a chave *anon public*.
4. Copie `.env.example` para `.env` e preencha:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=...
   ```
5. (Opcional) Em **Authentication → Providers → Email**, desative *Confirm email* para entrar sem confirmar o e-mail.

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
