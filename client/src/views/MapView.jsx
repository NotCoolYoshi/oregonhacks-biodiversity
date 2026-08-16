import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Rough center of Oregon — swap for the user's geolocation later.
const DEFAULT_CENTER = [44.0, -120.5]
const DEFAULT_ZOOM = 7

// ---------------------------------------------------------------------------
// TEMPORARY PLACEHOLDER DATA — delete this block when the real endpoint lands.
//
// There is no GET catches route on the server yet (api.js only writes them, via
// createCatch). Until there is, `loadCatches` below hands back this fixed list
// so the map is visually testable. Shapes match the `catches` table columns the
// map cares about: { id, taxon_id, common_name, type, lat, lng }.
// ---------------------------------------------------------------------------
const PLACEHOLDER_CATCHES = [
  {
    id: 'placeholder-1',
    taxon_id: 126887,
    common_name: 'Oregon grape',
    type: 'catch',
    lat: 44.0521,
    lng: -123.0868, // Eugene
  },
  {
    id: 'placeholder-2',
    taxon_id: 61317,
    common_name: 'Armenian Blackberry',
    type: 'threat_report',
    lat: 45.5152,
    lng: -122.6784, // Portland
  },
  {
    id: 'placeholder-3',
    taxon_id: 48256,
    common_name: 'Douglas-fir',
    type: 'catch',
    lat: 44.6365,
    lng: -124.0535, // Newport
  },
  {
    id: 'placeholder-4',
    taxon_id: 48538,
    common_name: 'Scotch Broom',
    type: 'threat_report',
    lat: 42.3265,
    lng: -122.8756, // Medford
  },
  {
    id: 'placeholder-5',
    taxon_id: 48227,
    common_name: 'bigleaf maple',
    type: 'catch',
    lat: 44.0582,
    lng: -121.3153, // Bend
  },
]

/**
 * The one place the map gets its data. Swap the body for the real call —
 * something like `getCatches(PLACE_ID)` in api.js — and nothing else in this
 * file needs to change. Async already, so the loading state stays honest.
 */
async function loadCatches() {
  return PLACEHOLDER_CATCHES
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

  useEffect(() => {
    let cancelled = false

    loadCatches().then((rows) => {
      if (cancelled) return
      setCatches(rows)
      setLoading(false)
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

      {!loading && catches.length === 0 && (
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
