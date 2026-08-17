-- ============================================================================
-- Migration 006 — a rarity column on catches.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR:
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
-- ============================================================================

alter table public.catches add column if not exists rarity text;
