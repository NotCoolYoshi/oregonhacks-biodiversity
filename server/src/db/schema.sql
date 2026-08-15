-- ============================================================================
-- RUN THIS ONCE, BY HAND, IN THE SUPABASE SQL EDITOR.
--
-- Nothing in this repo executes this file. There is no migration runner and no
-- startup hook — if you skip this step, POST /api/catches will fail with
-- "relation \"catches\" does not exist".
--
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Safe to re-run: every statement is IF NOT EXISTS.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto. Supabase enables it by default on new
-- projects, but this makes the dependency explicit.
create extension if not exists pgcrypto;

create table if not exists public.catches (
  id              uuid primary key default gen_random_uuid(),

  -- No auth yet: the client generates a session_id and keeps it in
  -- localStorage. Swap for auth.uid() when real accounts land.
  session_id      text        not null,

  taxon_id        integer     not null,
  scientific_name text        not null,
  common_name     text,

  -- 'catch'         = species is native to this place, goes in the dex
  -- 'threat_report' = species is introduced/invasive, gets flagged
  kind            text        not null check (kind in ('catch', 'threat_report')),

  place_id        integer,
  place_name      text,
  lat             double precision,
  lng             double precision,
  photo_url       text,
  confidence      numeric,

  created_at      timestamptz not null default now()
);

-- GET /api/region/:placeId/score groups by place_id.
create index if not exists catches_place_id_idx on public.catches (place_id);

-- The dex reads one session's catches, newest first.
create index if not exists catches_session_id_idx on public.catches (session_id);
create index if not exists catches_session_created_idx
  on public.catches (session_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The server talks to Supabase with the service role key, which bypasses RLS
-- entirely. Enabling RLS with no policies therefore changes nothing for the
-- API, but it does mean that if anyone ever points a browser client at this
-- table with the anon key, they get nothing instead of everything.
--
-- Leave this on. Add policies when/if the client talks to Supabase directly.
-- ---------------------------------------------------------------------------
alter table public.catches enable row level security;
