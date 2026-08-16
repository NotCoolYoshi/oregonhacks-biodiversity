import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getCatches, getRegionScore, resolvePlace } from '../api'

// Where the map opens when it has nothing better: the whole world, which is
// honest about knowing nothing. It used to be the middle of Oregon, which was
// a confident answer to a question nobody had asked.
const WORLD_VIEW = { center: [20, 0], zoom: 2 }

// Close enough to see individual pins, loose enough that a catch a town over is
// still on screen.
const LOCAL_ZOOM = 11

/**
 * The one place the map gets its data.
 *
 * Not scoped to a place any more. The map answers "what has been found", and
 * once catches can be logged in more than one region, filtering to a single
 * hardcoded one hides every catch made outside it. Which region the user is
 * looking at is now a matter of where the map is centred, not of which rows
 * were fetched.
 */
async function loadCatches() {
  return getCatches()
}

const isPlottable = (c) => typeof c.lat === 'number' && typeof c.lng === 'number'

/**
 * Where to open the map, in descending order of how much we actually know:
 *
 *   1. The browser's geolocation — the user is here, show them here.
 *   2. The most recent catch that has coordinates — not where they are, but
 *      somewhere they have been, which beats a stranger's region.
 *   3. The world.
 *
 * Resolves rather than rejects at every step: a map that fails to open is worse
 * than a map opened somewhere general.
 */
function currentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)

    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      // Same options as the capture flow: this is the same permission prompt,
      // and a position cached from it five minutes ago is a fine answer.
      { timeout: 10_000, maximumAge: 300_000 },
    )
  })
}

function chooseView({ position, catches }) {
  if (position) {
    return { center: [position.lat, position.lng], zoom: LOCAL_ZOOM, at: position, from: 'you' }
  }

  // Rows arrive newest first, so the first plottable one is the last place the
  // user caught something.
  const lastCatch = catches.find(isPlottable)
  if (lastCatch) {
    const at = { lat: lastCatch.lat, lng: lastCatch.lng }
    return { center: [at.lat, at.lng], zoom: LOCAL_ZOOM, at, from: 'last-catch' }
  }

  return { ...WORLD_VIEW, at: null, from: 'world' }
}

// ---------------------------------------------------------------------------

// divIcon rather than the default marker: Leaflet's default icon resolves its
// PNGs by relative URL and silently 404s under Vite, and a CSS-driven icon is
// what lets a catch and a threat_report differ in shape as well as colour.
//
// The colour and shape live on the inner <span>, never on the icon div itself.
// Leaflet positions markers by writing `transform: translate3d(...)` onto that
// div, so any `transform` in our own CSS would replace it and pile every marker
// onto the pane's top-left corner.
const pinIcon = (variant) =>
  L.divIcon({
    className: `map-pin map-pin-${variant}`,
    html: '<span class="map-pin-shape"></span>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12],
  })

const ICONS = {
  catch: pinIcon('catch'),
  threat_report: pinIcon('threat'),
}

const TYPE_LABELS = {
  catch: 'Catch',
  threat_report: 'Threat report',
}

/**
 * Region health, inherited from the removed Region dashboard.
 *
 * It sits above the map rather than on its own page because it is a reading of
 * the same thing the pins below are: what has been found here. Three numbers,
 * not the dashboard's full breakdown — the map is the subject of this page.
 *
 * The region is whichever one `at` falls in, resolved server-side — not a
 * constant. `at` is null when the map is on the world view, and a strip that
 * cannot name its region has nothing to report, so it renders nothing.
 *
 * Renders nothing when the score fails to load either. A stat strip is context
 * for the map, and a row of dashes is worse context than no row.
 */
function RegionStrip({ at }) {
  const [score, setScore] = useState(null)

  useEffect(() => {
    let cancelled = false
    setScore(null)

    if (!at) return undefined

    resolvePlace(at)
      .then((place) => getRegionScore(place.placeId))
      .then((data) => {
        if (!cancelled) setScore(data)
      })
      // Deliberately swallowed: the map is the page, and this strip failing is
      // not worth an error message on top of it. Coordinates in no iNaturalist
      // place (mid-ocean) land here too, as a 404.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [at])

  if (!score) return null

  return (
    <dl className="stat-strip">
      <div className="stat">
        <dt>Region</dt>
        {/* Named, because it is no longer always the same one. */}
        <dd className="stat-value stat-value-text">{score.placeName}</dd>
      </div>
      <div className="stat">
        {/* `score` is already 0-100 from the server, not a 0-1 fraction. */}
        <dt>Region health</dt>
        <dd className="stat-value">
          {score.grade === 'N/A' ? '—' : `${score.score}%`}
        </dd>
      </div>
      <div className="stat">
        <dt>Native species</dt>
        <dd className="stat-value">{score.totals?.uniqueNativeSpecies ?? 0}</dd>
      </div>
      <div className="stat">
        <dt>Threats reported</dt>
        <dd className="stat-value">{score.totals?.threatReports ?? 0}</dd>
      </div>
    </dl>
  )
}

function CatchMarkers({ catches }) {
  return catches.map((c) => (
    <Marker key={c.id} position={[c.lat, c.lng]} icon={ICONS[c.type] ?? ICONS.catch}>
      <Popup>
        <strong>{c.common_name ?? 'Unknown species'}</strong>
        <br />
        <span className={c.type === 'threat_report' ? 'map-popup-threat' : 'map-popup-catch'}>
          {TYPE_LABELS[c.type] ?? c.type}
        </span>
      </Popup>
    </Marker>
  ))
}

export default function MapView() {
  const [catches, setCatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState(null)

  useEffect(() => {
    let cancelled = false

    // Both at once: the position prompt and the catch list do not depend on
    // each other, and waiting for the prompt to be answered before fetching
    // would stall the map behind a permission dialog the user may ignore.
    // chooseView() needs both, so it runs after — but neither request does.
    Promise.all([currentPosition(), loadCatches()])
      .then(([position, rows]) => {
        if (cancelled) return
        const loaded = rows ?? []
        setCatches(loaded)
        setView(chooseView({ position, catches: loaded }))
      })
      .catch((err) => {
        // Now that this is a real request it can fail, and an unhandled
        // rejection would leave the map stuck on "Loading catches…" forever.
        if (cancelled) return
        setError(
          err?.response?.data?.error ??
            'Could not reach the server. If you are running this locally, check it is up on port 5001.',
        )
        // The catch list is what failed, not geolocation — but chooseView needs
        // it to pick a fallback, so without it the map opens on the world.
        setView({ ...WORLD_VIEW, at: null, from: 'world' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const plottable = catches.filter(isPlottable)
  const unplottable = catches.length - plottable.length

  return (
    <section>
      <h2>Map</h2>

      <RegionStrip at={view?.at ?? null} />

      {loading && <p className="capture-muted">Loading catches…</p>}

      {!loading && error && <p className="capture-note">{error}</p>}

      {!loading && !error && catches.length === 0 && (
        <p className="capture-note">Nothing caught anywhere yet — go catch something.</p>
      )}

      {!loading && view?.from === 'last-catch' && (
        <p className="capture-muted">
          Centred on your last catch — we could not get your location.
        </p>
      )}

      {!loading && view?.from === 'world' && catches.length > 0 && (
        <p className="capture-muted">
          Showing the whole world — we could not get your location, and no catch has coordinates
          to centre on.
        </p>
      )}

      {!loading && unplottable > 0 && (
        <p className="capture-muted">
          {unplottable} {unplottable === 1 ? 'catch has' : 'catches have'} no location and
          {unplottable === 1 ? ' is' : ' are'} not shown.
        </p>
      )}

      {/* Held back until the view is known. MapContainer reads `center` and
          `zoom` once, on mount, and ignores them afterwards — rendering it with
          a placeholder centre and correcting it later would leave the map
          wherever the placeholder put it. */}
      {view && (
        <MapContainer
          center={view.center}
          zoom={view.zoom}
          style={{ height: '70vh', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <CatchMarkers catches={plottable} />
        </MapContainer>
      )}

      <p className="capture-muted map-legend">
        <span className="map-swatch map-swatch-catch" aria-hidden="true" /> Catch
        <span className="map-swatch map-swatch-threat" aria-hidden="true" /> Threat report
      </p>
    </section>
  )
}
