-- Fechamentos de caixa pelo WhatsApp (função "fechamento-whatsapp").
-- Já aplicado no banco em 29/10/2026 (migração 20261029134105_whatsapp_fechamentos).

-- Registro de toda mensagem de fechamento recebida pelo robô do WhatsApp
create table if not exists public.whatsapp_mensagens (
  id uuid primary key default gen_random_uuid(),
  msg_id text unique,
  chat_id text,
  remetente text,
  remetente_nome text,
  texto text,
  status text not null default 'recebida', -- recebida | ok | erro | ignorada
  erro text,
  closing_id uuid references public.cash_closings(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.whatsapp_mensagens enable row level security;
create policy "logados leem mensagens whatsapp" on public.whatsapp_mensagens
  for select to authenticated using (true);

-- De onde veio o fechamento (app ou whatsapp)
alter table public.cash_closings add column if not exists origem text default 'app';

-- Token secreto que o robô usa pra falar com o Onion Cost
insert into public.app_secrets(name, value, updated_at)
values ('whatsapp_webhook_token', replace(gen_random_uuid()::text,'-',''), now())
on conflict (name) do nothing;
