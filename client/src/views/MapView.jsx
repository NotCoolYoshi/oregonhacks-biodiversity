import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getCatches } from '../api'

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
 * found here", so another user's sighting belongs on it. The dex is the
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
