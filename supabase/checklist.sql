-- Onion Cost — Checklist dinâmico da cozinha
-- Rode depois de usuarios.sql. Pode rodar mais de uma vez.

create or replace function public.app_can_manage(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where user_id = auth.uid() and ativo
      and (papel = 'master' or (papel = 'gerente' and 'checklist' = any (modulos) and u = any (unit_ids)))
  )
$$;
revoke execute on function public.app_can_manage(uuid) from anon;

-- Cadastro das tarefas (uma tarefa vale para uma ou mais unidades)
create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  grupo text not null default 'Geral',          -- ex.: Abertura, Fechamento, Limpeza
  unit_ids uuid[] not null,                      -- unidades onde aparece
  dias_semana int[] not null default '{0,1,2,3,4,5,6}', -- 0 = domingo … 6 = sábado
  exige_foto boolean not null default false,
  ordem int not null default 0,
  ativo boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table checklist_items enable row level security;

-- Lançamentos: uma tarefa feita por unidade e por dia
create table if not exists checklist_done (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references checklist_items(id) on delete cascade,
  unit_id uuid not null references units(id) on delete cascade,
  data date not null,
  feito_por uuid default auth.uid() references auth.users(id) on delete set null,
  feito_por_nome text,
  feito_em timestamptz not null default now(),
  foto_path text,
  obs text,
  unique (item_id, unit_id, data)
);
create index if not exists checklist_done_dia on checklist_done (unit_id, data);
alter table checklist_done enable row level security;

-- Ver tarefas: quem tem o módulo e alguma das unidades da tarefa
create or replace function public.app_any_unit(us uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and ativo and (papel = 'master' or us && unit_ids))
$$;
revoke execute on function public.app_any_unit(uuid[]) from anon;

drop policy if exists "ver tarefas" on checklist_items;
create policy "ver tarefas" on checklist_items for select to authenticated
  using (app_has_module('checklist') and app_any_unit(unit_ids));
-- Cadastrar/alterar: master, ou gerente só para as unidades dele
drop policy if exists "cadastrar tarefas" on checklist_items;
create policy "cadastrar tarefas" on checklist_items for insert to authenticated
  with check (cardinality(unit_ids) > 0 and (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_can_manage(u))));
drop policy if exists "alterar tarefas" on checklist_items;
create policy "alterar tarefas" on checklist_items for update to authenticated
  using (app_is_master() or (cardinality(unit_ids) > 0 and not exists (select 1 from unnest(unit_ids) u where not app_can_manage(u))))
  with check (cardinality(unit_ids) > 0 and (app_is_master() or not exists (select 1 from unnest(unit_ids) u where not app_can_manage(u))));
drop policy if exists "apagar tarefas" on checklist_items;
create policy "apagar tarefas" on checklist_items for delete to authenticated
  using (app_is_master() or (cardinality(unit_ids) > 0 and not exists (select 1 from unnest(unit_ids) u where not app_can_manage(u))));

-- Lançar/ver: módulo + unidade. Desfazer: quem fez, ou quem gerencia a unidade
drop policy if exists "ver lancamentos" on checklist_done;
create policy "ver lancamentos" on checklist_done for select to authenticated
  using (app_has_module('checklist') and app_has_unit(unit_id));
drop policy if exists "lancar" on checklist_done;
create policy "lancar" on checklist_done for insert to authenticated
  with check (app_has_module('checklist') and app_has_unit(unit_id) and feito_por = auth.uid());
drop policy if exists "desfazer" on checklist_done;
create policy "desfazer" on checklist_done for delete to authenticated
  using (app_has_unit(unit_id) and (feito_por = auth.uid() or app_can_manage(unit_id)));

-- Fotos (bucket privado). Caminho: <unit_id>/<AAAA-MM-DD>/<item_id>-<aleatório>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checklist', 'checklist', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "checklist fotos ver" on storage.objects;
create policy "checklist fotos ver" on storage.objects for select to authenticated
  using (bucket_id = 'checklist' and app_has_module('checklist') and app_has_unit(((storage.foldername(name))[1])::uuid));
drop policy if exists "checklist fotos enviar" on storage.objects;
create policy "checklist fotos enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'checklist' and app_has_module('checklist') and app_has_unit(((storage.foldername(name))[1])::uuid));
