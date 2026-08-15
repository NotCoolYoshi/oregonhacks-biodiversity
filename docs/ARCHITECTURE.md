# Architecture

OregonHacks 2026 · Nature + Tech · team of 3

## Shape of the system

```
  ┌─────────────────────────────┐
  │  client  (Vite + React)     │
  │  ├─ dex / catch UI          │
  │  └─ map / region view       │
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

**Dex / catch UI** (`PhotoCapture`, `DexView`) is the game loop. The user
photographs a plant, the app identifies it, and the result becomes either a
**catch** (species is native to the region) or a **threat report** (species is
introduced and flagged invasive). `DexView` shows what's been caught alongside
the "catchable nearby" list, so there's always a visible next thing to go find.
Phenology data drives *in season* badges — a species whose observations peak in
April shouldn't be dangled in front of the user in November.

**Map / region view** (`MapView`, `RegionDashboard`) is the collective layer.
`MapView` (Leaflet via react-leaflet) plots every catch and threat report as
markers, with invasives on their own visually distinct layer. `RegionDashboard`
renders the regional biodiversity health score plus its native/invasive
breakdown and recent activity.

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

**TODO: pick one.** Nothing in the code commits to either yet; `POST
/api/catches` and `GET /api/region/:placeId/score` are the only two routes that
will touch it.

| | Supabase | Firebase |
|---|---|---|
| Model | Postgres, real SQL | Document store |
| Aggregation | `GROUP BY` — the region score is one query | Manual, or maintain counters |
| Geo queries | PostGIS available | Needs workarounds |
| Auth | Built in | Built in |
| Image storage | Supabase Storage | Cloud Storage |
| Setup cost | Slightly higher | Slightly lower |

**Leaning Supabase**, because the region health score is fundamentally an
aggregate query (count distinct native species, count distinct invasives, group
by place) and that's a one-liner in SQL versus bookkeeping in Firestore. Decide
before anyone writes persistence code.

Tables we'll need either way:

- `users` — id, display name, home `place_id`
- `catches` — id, user_id, taxon_id, scientific_name, common_name, type
  (`catch` | `threat_report`), lat, lng, place_id, photo_url, confidence,
  created_at
- `species_cache` — taxon_id + place_id → establishment means, so we're not
  re-querying iNaturalist for every catch

## Open questions

- **Where does the photo live?** Right now `POST /api/identify` takes base64 in
  the request body (10mb cap). Fine for the demo; object storage is the real
  answer.
- **How is a region chosen?** Currently an iNaturalist `place_id` (Oregon = 10).
  Reverse-geocoding from the user's coordinates is nicer but is another
  dependency.
- **Anonymous users?** A dex is more compelling when it persists, but forcing
  signup before the first catch will lose demo-watchers.
