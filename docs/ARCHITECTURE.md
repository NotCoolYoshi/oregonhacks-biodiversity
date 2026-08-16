# Architecture

OregonHacks 2026 · Nature + Tech · team of 3

## Shape of the system

```
  ┌─────────────────────────────┐
  │  client  (Vite + React)     │
  │  ├─ catalogue / catch UI    │
  │  ├─ map / region strip      │
  │  └─ social / leaderboard    │
  └──────────────┬──────────────┘
                 │  HTTP, JSON only, no third-party keys
                 ▼
  ┌─────────────────────────────┐
  │  server  (Node + Express)   │   ← the single proxy layer
  └──┬───────────┬───────────┬──┘
     │           │           │
     ▼           ▼           ▼
  Pl@ntNet   iNaturalist    DB
  (photo ID) (status +    (catches,
             phenology)    users)
```

## Frontend — two halves, one app

The client is deliberately split down the middle so two people can work in it at
once without colliding.

**Catalogue / catch UI** (`PhotoCapture`, `CatalogueView`) is the game loop. The user
photographs a plant, the app identifies it, and the result becomes either a
**catch** (species is native to the region) or a **threat report** (species is
introduced and flagged invasive). `CatalogueView` shows what's been caught alongside
the "catchable nearby" list, so there's always a visible next thing to go find.
Phenology data drives *in season* badges — a species whose observations peak in
April shouldn't be dangled in front of the user in November.

**Map / social view** (`MapView`, `SocialView`) is the collective layer.
`MapView` (Leaflet via react-leaflet) plots every catch and threat report as
markers, with catches and invasives distinguished by marker shape as well as
colour, and carries the regional biodiversity health score in a stat strip
above the map. `SocialView` holds the leaderboard.

There is no separate region dashboard. The health score is a reading of what
the map is already showing, so it sits on the map rather than on a page of its
own, and the leaderboard moved to Social.

Both halves talk to the server through `client/src/api.js`, which is the only
place a URL is written down.

## Server — one proxy layer, and only one

`server/` is a plain Express app whose entire job is to sit between the browser
and everything else. It exists for three reasons:

1. **Keys stay server-side.** `PLANTNET_API_KEY` is loaded from `.env` via
   dotenv and never reaches the client. The client has no credentials at all.
2. **Shape normalization.** Pl@ntNet, iNaturalist, and GBIF each have their own
   response formats. The routes in `server/src/routes/api.js` flatten them into
   the small set of shapes the frontend actually wants, so a downstream API
   change is a one-file fix.
3. **A stable contract, available on day one.** Every route currently returns
   realistic mock JSON from `server/src/mocks.js` with a `TODO` marking where the
   real call goes. The frontend can be built to completion against these stubs
   and swapping in real calls changes nothing on the client.

CORS is configured to allow the Vite dev origin (`http://localhost:5173`,
overridable with `CLIENT_ORIGIN`). The server listens on **5001**, not 5000 —
macOS AirPlay Receiver holds 5000 and silently answers with `403`.

## Downstream dependencies

### 1. Pl@ntNet — photo identification

`POST /api/identify`. Image goes up as multipart form-data to
`https://my-api.plantnet.org/v2/identify/all`; ranked candidate species come
back. We map each result to `{ score, scientificName, commonNames, family,
gbifId, inatTaxonId }`. Rate-limited on the free tier — worth caching by image
hash if we start hitting the ceiling during the demo.

The `inatTaxonId` field is the hinge of the whole app: it's what lets a Pl@ntNet
identification be looked up in iNaturalist in the next step.

### 2. iNaturalist / GBIF — status and phenology

Three routes, all unauthenticated public APIs:

- `GET /api/species/:taxonId/status?place_id=` → `/v1/taxa/:id?place_id=`, read
  `establishment_means` and `conservation_status`. This is what decides catch vs.
  threat report — and it must be decided **server-side**, not by a client that
  could be edited to farm points.
- `GET /api/species/:taxonId/phenology?place_id=` → `/v1/observations/histogram`
  with `interval=month_of_year`, giving the 12-month observation curve.
- `GET /api/region/:placeId/nearby` → `/v1/observations/species_counts`, the
  species recently observed near a place.

GBIF is the fallback for taxa where iNaturalist has no establishment means for
our place. Both are courteous-use APIs: send a real User-Agent and don't hammer
them from a loop.

### 3. Database — catches and users

**Supabase.** It was picked over Firebase for Postgres and real SQL, and the
code commits to it — see `server/src/db/`: `schema.sql` for the table,
`migrations/` for changes to it, and `supabaseClient.js` for the connection.
`POST /api/catches` and `GET /api/region/:placeId/score` are the only two
routes that touch it.

Nothing in the repo runs the SQL. There is no migration runner: `schema.sql`
and each file in `migrations/` are pasted into the Supabase SQL editor by hand,
in order.

The server authenticates with the service role key, which bypasses Row Level
Security but **not** table-level grants — hence the `grant` at the bottom of
`schema.sql`. Missing it produces `42501: permission denied for table catches`,
which reads like an RLS problem and is not one.

What actually exists:

- `catches` — id, user_id, taxon_id, scientific_name, common_name, type
  (`catch` | `threat_report`), lat, lng, place_id, place_name, photo_url,
  confidence, created_at. Unique on (user_id, taxon_id, place_id), so the same
  bush cannot be farmed for points.

Not built:

- `users` — there is no auth. The browser generates an id and keeps it in
  localStorage (`client/src/session.js`); `user_id` on `catches` is that
  string, unverified.
- `species_cache` — establishment means is cached in memory instead, with a
  10-minute TTL in `server/src/services/inaturalist.js`. A table would survive
  restarts and is the better answer if lookups ever get hot.

### Aggregating the region score

`GET /api/region/:placeId/score` reads the rows for a place and aggregates them
**in JavaScript**, not in SQL. PostgREST — the API in front of Supabase's
Postgres — exposes no `GROUP BY` and no `COUNT(DISTINCT)`, so the "one query in
SQL" argument for Postgres does not survive contact with the client library.
Getting it back means a database view or an RPC, which is more DDL to apply by
hand; at demo scale the JS pass is the cheaper trade. `SCAN_LIMIT` in
`routes/api.js` caps the rows pulled — a region that outgrows it needs the view.

Counting distinct *native* species needs one extra hop. The `catches` row
records `type`, and `type` is `catch` both for species iNaturalist confirms are
native and for species it has no checklist entry for at all (see `classify()`
in `services/inaturalist.js`). Those two are not the same thing, so the score
route re-reads establishment means for the distinct taxa it found — one bulk,
cached call — rather than counting every catch as native. Persisting
establishment means on the row would remove that hop; it is not stored today.

## Open questions

- **Where does the photo live?** Right now `POST /api/identify` takes base64 in
  the request body (10mb cap). Fine for the demo; object storage is the real
  answer.
- **How is a region chosen?** Currently an iNaturalist `place_id` (Oregon = 10).
  Reverse-geocoding from the user's coordinates is nicer but is another
  dependency.
- **Anonymous users?** A catalogue is more compelling when it persists, but forcing
  signup before the first catch will lose demo-watchers.
