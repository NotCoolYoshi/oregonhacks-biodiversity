-- ============================================================================
-- Migration 002 — one catch per user, per species, per place.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR (same as 001):
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Why: points are the mechanic in this app, and nothing stopped a user from
-- photographing the same blackberry bush fifty times. The distinct-count
-- metrics in GET /api/region/:placeId/score resisted that, but totals.catches
-- and pointsAwarded did not.
--
-- POST /api/catches already refuses duplicates in application code, which is
-- what produces the friendly 409. This index is the backstop: two concurrent
-- requests can both pass that check before either inserts, and only the
-- database can actually settle that race.
--
-- Deliberately scoped to (user_id, taxon_id, place_id) rather than
-- (user_id, taxon_id): finding a species in a new region is a real
-- observation and should still be recordable. It just isn't a new dex entry,
-- which is what `isFirstCatch` reports separately.
--
-- Safe to re-run.
-- ============================================================================

-- If duplicates already exist this index cannot be created, so clear them
-- first, keeping the earliest row of each group — that is the one whose
-- isFirstCatch was legitimately true.
delete from public.catches a
using public.catches b
where a.user_id = b.user_id
  and a.taxon_id = b.taxon_id
  and a.place_id is not distinct from b.place_id
  and (a.created_at, a.id) > (b.created_at, b.id);

create unique index if not exists catches_user_taxon_place_uniq
  on public.catches (user_id, taxon_id, place_id);
