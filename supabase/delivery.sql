-- Onion Cost — taxas de delivery por canal (iFood, 99Food, Keeta…)
-- Cole em: Supabase > SQL Editor > New query > Run. Pode rodar mais de uma vez.

-- Configuração única: canais com as taxas, imposto e lucro desejado
alter table settings add column if not exists channels jsonb not null default '[]'::jsonb;
  -- [{id, name, commission_pct, payment_pct, fixed_fee, discount_pct, uses_packaging}]
alter table settings add column if not exists tax_pct numeric not null default 0;
alter table settings add column if not exists channel_margin_pct numeric not null default 20;

-- Em cada receita: embalagem de delivery por unidade e o preço praticado em cada canal
alter table recipes add column if not exists packaging_cost numeric not null default 0;
alter table recipes add column if not exists channel_prices jsonb not null default '{}'::jsonb;
  -- {"<id do canal>": 29.9}
