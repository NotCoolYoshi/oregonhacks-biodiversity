import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getCatches, getRegionScore } from '../api'

// Rough center of Oregon — swap for the user's geolocation later.
const DEFAULT_CENTER = [44.0, -120.5]
const DEFAULT_ZOOM = 7

// Every region in this app is Oregon for now, same as PhotoCapture's PLACE_ID.
// There is no place picker to build against yet.
const PLACE_ID = 10

/**
 * The one place the map gets its data.
 *
 * Scoped to the place, not to the current user: the map answers "what has been
 * found here", so another user's sighting belongs on it. The catalogue is the
 * per-user view, and it passes userId to the same endpoint.
 */
async function loadCatches() {
  return getCatches({ placeId: PLACE_ID })
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

/** Catches saved without geolocation have null lat/lng and cannot be plotted. */
const isPlottable = (c) => typeof c.lat === 'number' && typeof c.lng === 'number'

/**
 * Region health, inherited from the removed Region dashboard.
 *
 * It sits above the map rather than on its own page because it is a reading of
 * the same thing the pins below are: what has been found here. Three numbers,
 * not the dashboard's full breakdown — the map is the subject of this page.
 *
 * Renders nothing at all when the score cannot be loaded. A stat strip is
 * context for the map, and a row of dashes is worse context than no row.
 */
function RegionStrip() {
  const [score, setScore] = useState(null)

  useEffect(() => {
    let cancelled = false
    getRegionScore(PLACE_ID)
      .then((data) => {
        if (!cancelled) setScore(data)
      })
      // Deliberately swallowed: the map is the page, and this strip failing is
      // not worth an error message on top of it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!score) return null

  return (
    <dl className="stat-strip">
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

  useEffect(() => {
    let cancelled = false

    loadCatches()
      .then((rows) => {
        if (!cancelled) setCatches(rows ?? [])
      })
      .catch((err) => {
        // Now that this is a real request it can fail, and an unhandled
        // rejection would leave the map stuck on "Loading catches…" forever.
        if (cancelled) return
        setError(
          err?.response?.data?.error ??
            'Could not reach the server. If you are running this locally, check it is up on port 5001.',
        )
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

      <RegionStrip />

      {loading && <p className="capture-muted">Loading catches…</p>}

      {!loading && error && <p className="capture-note">{error}</p>}

      {!loading && !error && catches.length === 0 && (
        <p className="capture-note">No catches for this place yet — go catch something.</p>
      )}

      {!loading && unplottable > 0 && (
        <p className="capture-muted">
          {unplottable} {unplottable === 1 ? 'catch has' : 'catches have'} no location and
          {unplottable === 1 ? ' is' : ' are'} not shown.
        </p>
      )}

      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '70vh', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CatchMarkers catches={plottable} />
      </MapContainer>

      <p className="capture-muted map-legend">
        <span className="map-swatch map-swatch-catch" aria-hidden="true" /> Catch
        <span className="map-swatch map-swatch-threat" aria-hidden="true" /> Threat report
      </p>
    </section>
  )
}
