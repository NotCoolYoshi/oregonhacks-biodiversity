# DB / API Audit — v2 (2026-08-16 22:38 -0700)

**Supersedes `docs/db-api-audit-20260816.md` ("v1"). Treat v1 as stale — do
not use it as ground truth.** v1 was generated after migrations 004
(`004_add_catches_family.sql`) and 005 (`005_add_sightings.sql`) already
existed on disk, but its own schema section only accounted for
`schema.sql` + migrations 001–003. Concretely, v1:

- Claimed `catches` has no `family` column ("Missing: a family column") —
  migration 004 had already added one, on disk, before v1 was written.
- Never mentioned `public.sightings` at all — an entire third table
  (migration 005), already on disk before v1 was written.
- Never mentioned `GET /api/leaderboard` — already in `routes/api.js`
  before v1 was written.

This is a fresh pass, not a patch of v1. Every claim below was re-derived
directly from the current migration files and the current `routes/api.js`,
not carried over from v1.

**Method note (unchanged from v1):** no Supabase CLI/MCP session was
available in this environment (`supabase` CLI not installed, no live
project connection configured for this tool). This audit is built from
`server/src/db/{schema.sql,migrations/*.sql}`, read in order, plus every
route in `server/src/routes/api.js` that reads or writes them. Per that
file's `toDatabaseError()` table, those SQL files are the only source of
schema truth this app has — there is no migration runner and no ORM, so a
project that has had every file below run against it by hand matches what's
documented here exactly. "Populated with real data" below means *the
application code writes a real value to this column*, not that I queried
the live database — no live connection was available to confirm actual row
contents.

---

## 1. Full schema inventory, in order

| File | mtime | Adds/changes |
|---|---|---|
| `schema.sql` | — | Creates `public.catches` (id, user_id, taxon_id, scientific_name, common_name, **rarity**, type, place_id, place_name, lat, lng, photo_url, confidence, created_at — see §1a on `rarity`). 3 indexes + 1 unique index. RLS on, no policies. Grants CRUD to `service_role`. |
| `001_rename_kind_and_session_id.sql` | Aug 15 13:31 | Renames `catches.kind`→`type`, `catches.session_id`→`user_id` (guarded, idempotent). Renames the check constraint and two indexes to match. Re-grants CRUD to `service_role` (recovers from a real "table exists but ungranted" incident). |
| `003_add_users_table.sql` | Aug 15 19:13 | Creates `public.users` (user_id PK, display_name nullable, created_at). No FK to `catches.user_id` — deliberate, documented (a strict FK would have needed a backfill `catches` couldn't satisfy). RLS on, no policies. Grants CRUD to `service_role`. |
| `002_unique_catch_per_user_taxon_place.sql` | Aug 15 22:45 | Deletes pre-existing duplicate `(user_id, taxon_id, place_id)` rows (keeps earliest by `(created_at, id)`), then adds `catches_user_taxon_place_uniq` unique index on that triple. |
| **`004_add_catches_family.sql`** | Aug 16 15:33 | Adds `catches.family` (nullable text, no backfill — pre-migration rows keep `family = NULL` by design). Adds `catches_user_family_idx` on `(user_id, family)`. Explicitly documents the decision *not* to add a badge/achievement table — badges are computed on-the-fly from `catches`. |
| **`005_add_sightings.sql`** | Aug 16 19:32 | Creates `public.sightings` — a separate append-only log, one row per `POST /catches` call (new catalogue entry or not). Columns: id, user_id, taxon_id, catch_id (FK → `catches.id`, `on delete set null`), type, tier (`new`/`repeat_daily`/`repeat_extra`), base_points, streak_days, streak_multiplier, points_awarded, place_id, photo_url, created_at. 2 indexes. RLS on, no policies. Grants CRUD to `service_role`. This is the table `GET /leaderboard` and `totalPoints` on `GET /users/:userId` actually sum — **not** a `points` column on `catches`, which doesn't exist. |
| `006_add_catches_rarity.sql` | Aug 16 22:33 | `alter table public.catches add column if not exists rarity text;` — see §1a, this is redundant with `schema.sql` as it stands right now. |

**Coverage confirmed:** both `family` (004) and `sightings` (005) are fully
accounted for below — §2 (routes) and §3 (per-table detail) both cover them.

### 1a. A real inconsistency: `rarity` lives in two places, one of which broke convention

`schema.sql`'s `create table` statement for `catches` *already* includes a
`rarity text` column (confirmed via `git log -S"rarity" -- schema.sql` →
introduced by commit `2e1bf98`, "rarity random"). That same commit also
added migration 006, which does `add column if not exists rarity text` —
functionally the same change, applied twice, through two different
mechanisms, in the same commit.

This breaks the convention every other change in this directory has
followed: `schema.sql` is the one-time initial-setup script, and every
change after it goes through a numbered migration — `schema.sql` itself is
never edited retroactively. That convention is what makes "run every file
in order" a meaningful sync procedure. Here:

- A **brand-new** Supabase project running `schema.sql` today gets `rarity`
  for free — migration 006 becomes a no-op (`if not exists` guards it).
- An **existing** project that ran the pre-`2e1bf98` version of `schema.sql`
  (i.e. anyone who set up before today) needs 006 to catch up.

Both paths converge on the same live schema, so nothing is currently
broken — but anyone reading `schema.sql` alone now sees `rarity` as if it
had "always" been there, which the migration history contradicts. Flagging
this now so it doesn't repeat: the next column addition should go in a
migration only, per every prior migration's own stated convention.

No DB-level `check` constraint enforces `rarity`'s values (unlike `type`,
which has one). The app-level `VALID_RARITIES = ['N','R','SR','SSR','UR']`
in `routes/api.js` is the only thing constraining it — see §3.

---

## 2. Full route inventory

`server/src/routes/api.js` is still the only route file (`server/src/routes/`
has no other files; confirmed via `find`). 1504 lines, 14 routes currently
defined:

| Method & path | Auth required | Reads | Writes |
|---|---|---|---|
| `GET /places/resolve` | No | none | none |
| `POST /identify` | No | none | none |
| `GET /species/:taxonId/status` | No | none | none |
| `GET /species/:taxonId/phenology` | No | none | none |
| `GET /region/:placeId/nearby` | No | none | none |
| `GET /observations/nearby` | No | `catches` (taxon_id, filtered by `user_id`, best-effort — degrades to empty set on failure) | none |
| `POST /catches` | **Yes (Clerk)** | `catches` (dup/first-catch check), `sightings` (today's-count, streak) | `catches` (insert, conditional), `sightings` (insert, always), Storage (photo upload) |
| `GET /catches` | No | `catches` — optionally filtered by `userId`/`placeId` | none |
| `GET /supabase/all` | No | `catches` (all columns incl. `user_id`, no filter), `users` (all, no filter) | none |
| `POST /users` | **Yes (Clerk)** | `users` | `users` (upsert) |
| `GET /users/:userId` | No | `users`, `catches`, `sightings` — all filtered by `:userId` | none |
| `GET /users/:userId/achievements` | No | `catches` — filtered by `:userId` | none |
| `GET /leaderboard` | No | `sightings`, `catches`, `users` — all unfiltered, capped at `SCAN_LIMIT` | none |
| `GET /region/:placeId/score` | No | `catches` — filtered by `:placeId` | none |

**Auth model, confirmed from `server/src/middleware/clerkAuth.js`:** this is
a deliberate, documented design, not an oversight — the file's header
comment states "Auth guard for the two write routes: POST /catches and
POST /users... Everything else stays open." Every other route is
intentionally unauthenticated. Keep that framing in mind for §4 — most of
what follows isn't "should be locked down," it's "is this open-by-design
route scoped the way its siblings are."

**Route-removal check:** `git log -p --all -- server/src/routes/api.js`
shows every route signature that was ever removed was re-added in the same
or a later commit with a superset of behavior (adding `async`, adding
`requireClerkUser`) — no route was ever added and then permanently dropped.
The 14 above is the complete, current set; nothing is missing that once
existed.

**`GET /supabase/all` is new since v1** (added by the same lineage that also
touched `App.jsx`/`App.css` outside this audit's scope — not investigating
that further per your hold). It has no doc-comment beyond one line
("Fetches all data stored in Supabase tables... along with counts and
metadata") and isn't wired to any client route I found evidence of in this
pass — reads like a debug/inspection endpoint. See §4.

---

## 3. Per-table detail

### `public.catches`

| Column | Populated with real data? | Written by |
|---|---|---|
| `id`, `created_at` | Yes — DB-generated | insert default |
| `user_id` | Yes — Clerk's verified user id | `POST /catches` |
| `taxon_id`, `scientific_name`, `common_name` | Yes — iNaturalist-preferred, client-fallback | `POST /catches` |
| `type` | Yes — server-computed from iNaturalist establishment means, never client-trusted | `POST /catches` |
| `place_id`, `place_name`, `lat`, `lng` | Yes — server-resolved / client-supplied | `POST /catches` |
| `photo_url` | Yes, when a photo is submitted — server-uploaded or client-URL passthrough | `POST /catches` |
| `confidence` | Yes — client-supplied Pl@ntNet confidence, unverified passthrough | `POST /catches` |
| `family` | **Sometimes** — client-supplied (Pl@ntNet's), trimmed to `null` if absent. Rows written before migration 004 are permanently `NULL` by design (see §1). | `POST /catches` |
| `rarity` | **Yes, on every new row — but the value is random, not computed.** `VALID_RARITIES[Math.floor(Math.random() * VALID_RARITIES.length)]` — a uniform random pick from `['N','R','SR','SSR','UR']` on every insert, unrelated to species scarcity or anything else. **This is exactly the column a "rarity" stat widget would reach for, and right now it means nothing.** |

Read by: `GET /catches`, `GET /users/:userId`, `GET /users/:userId/achievements`,
`GET /region/:placeId/score`, `GET /leaderboard`, `GET /observations/nearby`
(internal `caughtTaxonIds()` helper), `GET /supabase/all`, and internally by
`POST /catches` itself (dup-check, family-sequence count).

### `public.users`

| Column | Populated with real data? | Written by |
|---|---|---|
| `user_id` | Yes — Clerk's verified user id | `POST /users` |
| `display_name` | Yes — client-supplied (length-capped, unsanitized) or server-generated default (`"Explorer NNNN"`) | `POST /users` |
| `created_at` | Yes — DB default | insert |

Read by: `GET /users/:userId`, `GET /leaderboard`, `GET /supabase/all`,
internally by `POST /users` (existence check for its upsert logic).

### `public.sightings`

| Column | Populated with real data? | Written by |
|---|---|---|
| `id`, `created_at` | Yes — DB-generated | insert default |
| `user_id`, `taxon_id`, `type`, `place_id`, `photo_url` | Yes — mirrors the corresponding `POST /catches` submission | `POST /catches` |
| `catch_id` | Yes when a catalogue row exists for this submission (new or prior), else `NULL` | `POST /catches` |
| `tier` | Yes — computed server-side (`new` / `repeat_daily` / `repeat_extra`) from this user's catch/sighting history | `POST /catches` |
| `base_points`, `streak_days`, `streak_multiplier`, `points_awarded` | Yes — fully server-computed scoring pipeline (`SCORING` table × `streakMultiplier()`) | `POST /catches` |

Read by: `GET /users/:userId` (totalPoints, via sum), `GET /leaderboard`
(totalPoints per user), and internally by `POST /catches` itself
(`computeStreakDays()`, `todaysSightingCount()`).

**This is the table your stat widget almost certainly wants for anything
points/streak/tier-shaped** — it's real, server-computed, and it's the one
place `totalPoints` is actually sourced from everywhere it's shown. `rarity`
on `catches` is not a reliable source for anything today (see above);
`family` is real but has NULLs for any pre-migration-004 row.

---

## 4. Scoping-inconsistency pattern check

The pattern flagged earlier (`GET /catches` optionally-scoped vs.
`GET /region/:placeId/score` always-scoped) does exist, and I found one more
instance of the same shape, worth ranking by how much it matters:

1. **`GET /catches`** — accepts optional `?userId=` and `?placeId=`, ANDs
   them when both given, but **defaults to every row in the table**
   (capped at `SCAN_LIMIT`) when neither is supplied. Deliberately excludes
   `user_id` from its `select()` — the code comment says so explicitly
   ("that is the one column here that identifies a person, and no caller
   needs it back"). So: unscoped-by-default, but the one identity-linking
   column is withheld even then. Low severity as shipped.

2. **`GET /supabase/all`** — **new since v1, and this is the sharper case of
   the same pattern.** No filters exist at all (not even optional ones),
   no auth, and — unlike `GET /catches` — its `select()` for `catches`
   **explicitly includes `user_id`** (line 1007's column list). So the one
   open route that was careful to strip identity-linking data is sitting
   next to another open route that hands back the same table *with* that
   column, plus every `users.display_name`, to anyone, unfiltered. Given
   the documented "reads stay open" policy this isn't a violation of
   stated intent, but it is inconsistent with the specific privacy
   reasoning `GET /catches` itself states in its own comments — worth a
   second look, and worth deciding on purpose rather than by omission,
   especially since it also isn't the freshest read of the schema (see
   next point).

3. **Also worth noting**: `GET /supabase/all`'s hand-written column list
   (line 1007) does **not** include `sightings` at all — it dumps `catches`
   and `users` only. So the one endpoint whose entire purpose is "fetch all
   data stored in Supabase tables" is itself out of sync with migration 005,
   the same category of staleness this whole re-run exists to catch. If
   this route is meant to be a complete debug dump, it currently isn't one.

**Routes that are correctly, consistently scoped** (for contrast — most of
the surface is fine): `POST /catches` and `POST /users` (Clerk-scoped to
the caller, cannot be pointed at another user); `GET /region/:placeId/score`
and `GET /region/:placeId/nearby` (placeId is a required path segment, no
unscoped form exists); `GET /users/:userId` and
`GET /users/:userId/achievements` (userId is a required path segment).
`GET /leaderboard` reads all three tables unfiltered by design — that's
correct for a leaderboard, not an inconsistency.

---

## 5. Summary — what this means for the stat widget

- **Use `sightings.points_awarded`** (summed) for anything points-shaped —
  it's real, it's what every other points display in this app already
  reads, and it'll stay consistent with them for free.
- **Do not use `catches.rarity`** for a rarity stat yet — it's populated on
  every row, but with a uniform random value, not a real rarity signal.
  If the widget wants "rarest catch," this column will currently produce a
  meaningless answer that happens to look plausible.
- **`catches.family`** is usable but expect `NULL` on anything caught
  before Aug 16 ~15:33 — don't build a widget that assumes every row has
  one.
- If the widget's data source ends up being `GET /supabase/all` for
  convenience (it's the only "give me everything" route), know going in
  that it's missing `sightings` and is broader/less filtered than
  `GET /catches` or `GET /users/:userId` — probably not the right choice
  for a scoped, per-user or per-place widget; those two are.

---

*Not committed. Held for review per instructions — do not treat this file
as ground truth for other sessions until it's been looked at and
committed on purpose.*
