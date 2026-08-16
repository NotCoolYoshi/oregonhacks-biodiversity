# OregonHacks Biodiversity

Photograph a plant and find out what it is — then find out whether it belongs
here. Species native to your region get added to your personal **catalogue**; species
that are introduced and invasive get filed as a **threat report** instead. Every
catch and report lands on a shared live map and feeds a regional biodiversity
health score, so a walk around the block turns into a small act of citizen
science. Built for OregonHacks 2026 (Aug 15–17, "Nature + Tech").

## Setup

```bash
git clone <repo-url>
cd oregonhacks-biodiversity

# install root, server, and client dependencies
npm run install:all
# (equivalent to: npm install && npm --prefix server install && npm --prefix client install)

# configure the server
cp server/.env.example server/.env
# then open server/.env and fill in PLANTNET_API_KEY
# (get a free key at https://my.plantnet.org/)

# create the storage bucket catch photos live in (idempotent; needs the
# Supabase keys in server/.env). The SQL in server/src/db/ is still applied by
# hand in the Supabase SQL editor — see the header of schema.sql.
npm --prefix server run setup:storage

# run client + server together
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:5001 (health check at `/health`)

The server currently returns mock data for every route, so `PLANTNET_API_KEY`
can stay empty until we wire up the real Pl@ntNet call.

> **Why port 5001 and not 5000?** On macOS, AirPlay Receiver binds port 5000 and
> answers requests with a `403` — which looks exactly like a broken server. If
> you'd rather use 5000, turn AirPlay Receiver off in System Settings › General ›
> AirDrop & Handoff, then set `PORT=5000` in `server/.env` and
> `VITE_API_URL=http://localhost:5000` in `client/.env`.

## API endpoints

All routes are served by the Express app in `server/`, which is the only thing
that talks to external APIs. See `docs/ARCHITECTURE.md` for why.

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/identify` | Identify a plant from a photo; returns ranked candidate species. Proxies Pl@ntNet. |
| `GET` | `/api/places/resolve?lat=&lng=` | Coordinates → the iNaturalist place whose species list applies there. |
| `GET` | `/api/species/:taxonId/status?lat=&lng=` | Establishment means + conservation status for a taxon **where the photo was taken** — decides catch vs. threat report. |
| `GET` | `/api/species/:taxonId/phenology?lat=&lng=` | Monthly observation histogram; which months this species is typically visible. |
| `GET` | `/api/region/:placeId/nearby` | Species recently observed near a place — the "catchable nearby" list. |
| `GET` | `/api/observations/nearby?lat=&lng=&radius=&userId=` | Plants observed around a coordinate that `userId` has **not** caught — the map's "nearby unknown plants" layer. One row per taxon, 30 max. |
| `POST` | `/api/catches` | Record a catch or a threat report, uploading its photo to storage. |
| `GET` | `/api/catches?userId=&placeId=` | Recorded catches, newest first, with photo URLs. |
| `GET` | `/api/region/:placeId/score` | Aggregated biodiversity health score for a region. |

The place a verdict is about comes from the submitted coordinates, not a
constant — pass `lat`/`lng` and the server resolves the rest. A request with
neither falls back and reports `placeSource: "fallback"` so the UI can say the
verdict is not local.

### The nearby-unknowns layer, and what it costs

`/api/observations/nearby` is the only route a user can trigger by *moving*
rather than by acting, so it is the only one whose cost scales with fidgeting.
Four things hold that down, and all four matter:

- **A ~1km grid cache, 24h** (`getNearbyObservations`). The requested radius is
  turned into a bounding box snapped outward to a 0.01° grid, and the box is
  the cache key — so two viewports less than a cell apart are one entry.
- **A 900ms settle-debounce on the client** (`SETTLE_MS`). Not a throttle: the
  timer restarts on every `moveend`, so a drag across three counties costs one
  request, made when the user stops.
- **A minimum-movement gate** (`MIN_MOVE_FRACTION`). A pan shorter than half the
  viewport radius does not schedule a fetch at all — the visible area barely
  changed, so the answer would barely change. Zoom changes are never gated: a
  different radius is a different question.
- **A 30-marker ceiling** (`NEARBY_MARKER_CAP`), enforced server-side and not
  raisable by a query param, plus a client-side floor of zoom 9 below which the
  layer switches itself off rather than pretending a continent is "nearby".

The settle and the gate are the two that bite when every viewport is new
ground, which is the case the cache cannot help — a genuinely new area is a
genuine cache miss. They were raised from 500ms/none after the first pass
measured a worst case of ~77 calls/min, over iNaturalist's ceiling.

Measured with a real browser against real iNaturalist: **~5 calls/min for a
normal look around, ~3/min when revisiting, and a worst case of ~30/min** for
one user panning continuously and deliberately onto new ground — comfortably
under iNaturalist's ~60/min courtesy ceiling. Driving the map as fast as its
own zoom and keyboard controls allow does not get above ~20/min.

Note for anyone re-measuring: a pan-around script written against the old
500ms settle will under-report, because pauses shorter than 900ms never fire
the timer at all. Pause past `SETTLE_MS` and pan further than the gate, or the
numbers will look better than they are.

The layer is additive and never load-bearing: every failure path ends in an
empty layer and a console warning, and the catch markers, region strip and map
carry on without it.

### Photo storage

Catch photos go in the Supabase storage bucket **`catch-photos`**: public read,
`image/jpeg` only, 5 MB ceiling. Uploads are server-side with the service role
key — there is no anonymous write policy and the client holds no Supabase
credential. The browser resizes to 1600px on the long edge and re-encodes at 80%
JPEG (`client/src/image.js`) before anything is sent, which takes a 12-megapixel
phone photo from ~1.5 MB to ~300 KB.

Every route is stubbed with realistic mock JSON (`server/src/mocks.js`) and a
`TODO` where the real call goes — build against these shapes now, swap in real
data later without touching the client.

## Team

| Who | Area | Owns |
|---|---|---|
| **[TEAMMATE 1]** | Backend & data integration | `server/` — Pl@ntNet and iNaturalist calls, database choice and schema, the region score |
| **[TEAMMATE 2]** | Game / catalogue UI | `client/src/views/PhotoCapture.jsx`, `CatalogueView.jsx` — capture flow, catch vs. threat, collection |
| **[TEAMMATE 3]** | Map & social view | `client/src/views/MapView.jsx`, `SocialView.jsx` — Leaflet map, markers, region stat strip, leaderboard |

Shared surface: `client/src/api.js` and `server/src/routes/api.js` define the
contract between the three areas. Changing a response shape means telling the
other two.

## Project structure

```
client/          Vite + React app
  src/api.js       every server call, in one place
  src/image.js     canvas resize + JPEG re-encode, before any upload
  src/sighting.js  season, distance, and coordinate helpers
  src/views/       PhotoCapture, CatalogueView, SpeciesDetail, MapView, SocialView
server/          Node + Express proxy layer
  src/index.js     app setup, CORS, dotenv
  src/routes/      the six API routes
  src/mocks.js     fixtures backing the stubs
docs/
  ARCHITECTURE.md
```
