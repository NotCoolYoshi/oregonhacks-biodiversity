-- ============================================================================
-- Migration 005 — a sightings log, for scoring.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR (same as 001-004):
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Nothing in this repo executes it. There is no migration runner; the service
-- role key talks to PostgREST, which cannot run DDL.
--
-- Why a separate table rather than reusing `catches`: `catches` is the
-- catalogue — one row per (user, taxon, place), enforced by the unique index
-- in schema.sql — and that stays untouched. But the scoring model needs to
-- reward (at a lower rate) a user re-photographing a species they already
-- caught, which is exactly the case that unique index blocks a second
-- `catches` row for. `sightings` logs every submission — new species,
-- same-day repeats, next-day repeats, all of it — independent of whether it
-- produced a new catalogue row. POST /api/catches writes exactly one
-- `sightings` row per request and, separately, zero or one `catches` row.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists public.sightings (
  id                uuid primary key default gen_random_uuid(),

  user_id           text not null,
  taxon_id          integer not null,

  -- The catalogue row this sighting is about, if one exists. Null for a
  -- repeat sighting that did not create (or match) a `catches` row at
  -- insert time in some future schema change; today POST /api/catches always
  -- resolves this to an existing or newly-inserted catches.id.
  catch_id          uuid references public.catches(id) on delete set null,

  type              text not null check (type in ('catch', 'threat_report')),

  -- 'new'          — first time ever this user has logged this species.
  -- 'repeat_daily' — first sighting of it today, on a later day than 'new'.
  -- 'repeat_extra' — an additional sighting of it, later the same day.
  tier              text not null check (tier in ('new', 'repeat_daily', 'repeat_extra')),

  base_points       integer not null,
  streak_days       integer not null default 0,
  streak_multiplier numeric not null default 1,
  points_awarded    integer not null,

  place_id          integer,
  photo_url         text,

  created_at        timestamptz not null default now()
);

-- GET /api/users/:userId sums points_awarded for one user; GET /api/leaderboard
-- and POST /api/catches's streak/same-day lookups all filter on user_id first.
create index if not exists sightings_user_created_idx
  on public.sightings (user_id, created_at desc);

-- POST /api/catches's todaysSightingCount() filters on (user_id, taxon_id).
create index if not exists sightings_user_taxon_created_idx
  on public.sightings (user_id, taxon_id, created_at desc);

alter table public.sightings enable row level security;
grant select, insert, update, delete on public.sightings to service_role;
