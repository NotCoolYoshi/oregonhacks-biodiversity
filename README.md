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
| `GET` | `/api/species/:taxonId/status?place_id=` | Establishment means + conservation status for a taxon in a place — decides catch vs. threat report. |
| `GET` | `/api/species/:taxonId/phenology?place_id=` | Monthly observation histogram; which months this species is typically visible. |
| `GET` | `/api/region/:placeId/nearby` | Species recently observed near a place — the "catchable nearby" list. |
| `POST` | `/api/catches` | Record a catch or a threat report. |
| `GET` | `/api/region/:placeId/score` | Aggregated biodiversity health score for a region. |

Every route is stubbed with realistic mock JSON (`server/src/mocks.js`) and a
`TODO` where the real call goes — build against these shapes now, swap in real
data later without touching the client.

## Team

| Who | Area | Owns |
|---|---|---|
| **[TEAMMATE 1]** | Backend & data integration | `server/` — Pl@ntNet and iNaturalist calls, database choice and schema, the region score |
| **[TEAMMATE 2]** | Game / catalogue UI | `client/src/views/PhotoCapture.jsx`, `CatalogueView.jsx` — capture flow, catch vs. threat, collection |
| **[TEAMMATE 3]** | Map & region view | `client/src/views/MapView.jsx`, `RegionDashboard.jsx` — Leaflet map, markers, score dashboard |

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
