-- ============================================================================
-- Migration 003 — a users table, so a user has a name and not just an id.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR (same as 001 and 002):
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run
--
-- Why: catches.user_id is the only trace a user leaves today, and it is a
-- localStorage UUID. Every view that wants to greet someone, or put a name on
-- a leaderboard, has nowhere to read one from. This table is that one column,
-- plus the row it needs to hang on.
--
-- Deliberately NOT a foreign key from catches.user_id to users.user_id.
-- catches already holds rows whose user_ids predate this table, and a strict
-- FK would demand a backfill before it could be created at all. The id stays
-- what it has always been — a client-generated string the server takes on
-- trust — and this table is an optional annotation on it, not its registry.
-- Every read of it therefore has to tolerate a missing row; GET /api/users/:id
-- returns zeros rather than a 404 for exactly that reason.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists public.users (
  -- Matches catches.user_id in spirit and in type: the same localStorage id,
  -- text, no FK in either direction. See the note above.
  user_id      text        primary key,

  -- Nullable on purpose. POST /api/users generates a default ("Explorer 4821")
  -- when the client does not supply one, but a row written any other way is
  -- still a valid row — the client renders a missing name as 'Guest'.
  display_name text,

  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Same reasoning as public.catches in schema.sql: the server holds the service
-- role key and bypasses RLS entirely, so enabling it with no policies changes
-- nothing for the API. It does mean a browser pointed at this table with the
-- anon key gets nothing instead of every display name in the database.
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- The service role bypasses RLS but NOT table-level grants. Without this every
-- query comes back as `42501: permission denied for table users`, which reads
-- like an RLS problem and is not one. Migration 001 learned this the hard way.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.users to service_role;
