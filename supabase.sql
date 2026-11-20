-- Capte – schéma de la base de données (à exécuter une fois dans Supabase → SQL Editor → New query → Run)

create table if not exists public.capte_items (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type        text not null check (type in ('task', 'note')),
  domain      text not null check (domain in ('perso', 'pro')),
  title       text not null,
  body        text not null default '',
  due         date,
  time        text,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false   -- suppression « douce » : rien n'est jamais effacé physiquement
);

create index if not exists capte_items_user_idx on public.capte_items (user_id, updated_at);

-- Sécurité : chaque utilisateur ne voit et ne modifie que ses propres données
alter table public.capte_items enable row level security;

drop policy if exists "capte_select_own" on public.capte_items;
drop policy if exists "capte_insert_own" on public.capte_items;
drop policy if exists "capte_update_own" on public.capte_items;

create policy "capte_select_own" on public.capte_items for select to authenticated using (auth.uid() = user_id);
create policy "capte_insert_own" on public.capte_items for insert to authenticated with check (auth.uid() = user_id);
create policy "capte_update_own" on public.capte_items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- Pas de politique DELETE : l'app ne peut pas effacer définitivement une ligne (protection contre la perte de données).
