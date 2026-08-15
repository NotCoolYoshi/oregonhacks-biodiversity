-- ============================================================================
-- Migration 001 — align the catches table with the names the code already uses.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR:
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Nothing in this repo executes it. There is no migration runner; the service
-- role key talks to PostgREST, which cannot run DDL.
--
-- Why: schema.sql shipped with `kind` and `session_id`, but routes/api.js and
-- client/src/api.js were already written against `type` and `userId`. Renaming
-- the two columns touches one file; renaming them in the code touches both the
-- server and the client, so the schema moves.
--
--   kind       -> type
--   session_id -> user_id
--
-- Renames, not DROP/recreate, so existing rows survive. Every statement is
-- guarded, so re-running this file is safe and a database that already
-- matches schema.sql's current state is left alone.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Postgres has no ALTER TABLE ... RENAME COLUMN IF EXISTS, hence the guards.
-- Renaming a column automatically carries the check constraint and the indexes
-- that reference it with it — they keep working, they just keep their old
-- names until section 2 fixes those too.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'catches' and column_name = 'kind'
  ) then
    alter table public.catches rename column kind to type;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'catches' and column_name = 'session_id'
  ) then
    alter table public.catches rename column session_id to user_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Constraint and index names
--
-- Cosmetic — a constraint called catches_kind_check on a column called `type`
-- is exactly the sort of thing that wastes ten minutes at 2am during a
-- hackathon.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.catches'::regclass and conname = 'catches_kind_check'
  ) then
    alter table public.catches rename constraint catches_kind_check to catches_type_check;
  end if;
end $$;

alter index if exists public.catches_session_id_idx rename to catches_user_id_idx;
alter index if exists public.catches_session_created_idx rename to catches_user_created_idx;

-- ---------------------------------------------------------------------------
-- 3. Privileges
--
-- Not part of the rename, but this database needs it: the table was created
-- without any grant to service_role, so every query through PostgREST came
-- back as
--
--   42501: permission denied for table catches
--
-- The service role key is what the server authenticates with, and it bypasses
-- RLS but NOT table-level grants. Row Level Security stays on (see schema.sql)
-- so the anon key still sees nothing.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.catches to service_role;
