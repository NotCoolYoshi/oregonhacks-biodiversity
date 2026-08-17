-- ============================================================================
-- Migration 007 — a real rarity score on catches.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR (same as 001-005):
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Nothing in this repo executes it. There is no migration runner; the service
-- role key talks to PostgREST, which cannot run DDL.
--
-- AFTER RUNNING: verify it actually landed before touching app code. Migration
-- 006 was written, committed, and never actually run against this project for
-- days without anyone noticing, because nothing checked. Confirm with either:
--   - GET {SUPABASE_URL}/rest/v1/ (with an apikey header) and look for the
--     five columns below under definitions.catches.properties, or
--   - select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'catches';
-- See docs/rarity-scoring-plan-20260817.md §0 for why this step is not
-- optional this time.
--
-- Replaces migration 006 (see that file — left in place, emptied, not
-- deleted). `rarity` was a bare `text` column filled with
-- Math.random() over five letter-grades; nothing here is compatible with it,
-- and nothing should try to be. `schema.sql`'s own `rarity text` line has
-- also been removed, restoring the convention every other column here
-- follows: schema.sql is initial setup only, every later column goes through
-- a numbered migration.
--
-- What these columns are, and why five instead of one:
--   The three `rarity_*_count`/`rarity_conservation_*` columns are the RAW
--   inputs a score was computed from, captured once at catch time (POST
--   /catches, alongside the existing getTaxonStatus() call — see
--   server/src/routes/api.js and server/src/services/rarity.js). Storing the
--   raw inputs, not just the final number, is what makes re-banding free if
--   the provisional cutoffs below turn out wrong: an UPDATE from data already
--   in the table, never a re-fetch from iNaturalist.
--
--   rarity_score is the real source of truth: a 0-1 combined score, log-scale
--   place-scoped observation count (inverted, capped ~10,000 — see
--   rarity.js) averaged 50/50 with a normalized conservation-status ordinal
--   when iNaturalist has a real assessment, or the observations score alone
--   at full weight when it doesn't (the majority case today — see the plan
--   doc's real-data survey, 0 of 16 live species had one).
--
--   rarity_band is PROVISIONAL Common/Uncommon/Rare/Very-Rare text, derived
--   from rarity_score by server/src/services/rarity.js's bandFor(). Stored
--   (denormalized) rather than computed per-read, matching how `type` and
--   `family` already work on this table. If the cutoffs move, re-derive this
--   column from the stored rarity_score for every row — again, no re-fetch.
--
-- No backfill here — see server/scripts/backfill-rarity.mjs, run separately,
-- same dry-run-by-default / --apply pattern as backfill-places.mjs.
--
-- Safe to re-run.
-- ============================================================================

alter table public.catches
  add column if not exists rarity_observations_count integer,
  add column if not exists rarity_conservation_status text,
  add column if not exists rarity_conservation_iucn smallint,
  add column if not exists rarity_score numeric(4, 3),
  add column if not exists rarity_band text;

-- The dead column from migration 006. Harmless no-op on this project (it was
-- never actually added here — see that file's header) but real elsewhere:
-- anyone who *did* run 006 by hand gets cleaned up too.
alter table public.catches drop column if exists rarity;
