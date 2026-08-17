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

  -- No auth yet: the client generates an id and keeps it in localStorage.
  -- Swap for auth.uid() when real accounts land. Named user_id (not
  -- session_id) to match the `userId` the API and client already speak.
  user_id         text        not null,

  taxon_id        integer     not null,
  scientific_name text        not null,
  common_name     text,
  rarity          text,

  -- 'catch'         = species is native to this place, goes in the catalogue
  -- 'threat_report' = species is introduced/invasive, gets flagged
  --
  -- Set server-side from the iNaturalist establishment means, never from the
  -- client's claim — see POST /api/catches in routes/api.js.
  type            text        not null check (type in ('catch', 'threat_report')),

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

-- The catalogue reads one user's catches, newest first.
create index if not exists catches_user_id_idx on public.catches (user_id);
create index if not exists catches_user_created_idx
  on public.catches (user_id, created_at desc);

-- One catch per user, per species, per place — otherwise the same bush can be
-- photographed repeatedly for points. POST /api/catches also checks this in
-- application code to produce a friendly 409; the index is what settles the
-- race between two concurrent requests.
--
-- Scoped to include place_id on purpose: the same species in a new region is
-- still a real observation, just not a new catalogue entry.
--
-- (place_id is nullable, and Postgres treats NULLs as distinct in a unique
-- index. The route always writes one, defaulting to Oregon, so this holds in
-- practice — if place_id ever becomes genuinely optional, make it NOT NULL or
-- add NULLS NOT DISTINCT.)
create unique index if not exists catches_user_taxon_place_uniq
  on public.catches (user_id, taxon_id, place_id);

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

-- ---------------------------------------------------------------------------
-- Privileges
--
-- The service role bypasses RLS but NOT table-level grants. Without this the
-- server gets `42501: permission denied for table catches` on every query,
-- which is easy to misread as an RLS problem and is not one.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.catches to service_role;
