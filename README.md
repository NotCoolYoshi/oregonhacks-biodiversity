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
| `POST` | `/api/catches` | Record a catch or a threat report, uploading its photo to storage. |
| `GET` | `/api/catches?userId=&placeId=` | Recorded catches, newest first, with photo URLs. |
| `GET` | `/api/region/:placeId/score` | Aggregated biodiversity health score for a region. |

The place a verdict is about comes from the submitted coordinates, not a
constant — pass `lat`/`lng` and the server resolves the rest. A request with
neither falls back and reports `placeSource: "fallback"` so the UI can say the
verdict is not local.

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
  src/views/       PhotoCapture, CatalogueView, MapView, SocialView
server/          Node + Express proxy layer
  src/index.js     app setup, CORS, dotenv
  src/routes/      the six API routes
  src/mocks.js     fixtures backing the stubs
docs/
  ARCHITECTURE.md
```
