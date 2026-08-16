import { useCallback, useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { getCatches, getRegionScore, resolvePlace, getNearbyObservations } from '../api'
import { getUserId } from '../session'
import { taxonToIconCategory } from '../taxonCategory'
import { categoryIcon, legendSvg, LEGEND_CATEGORIES } from '../markerIcons'

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
//
// Catches and threat reports no longer come through here — they carry a species
// glyph now and are drawn as SVG in markerIcons.js. This is the nearby-unknown
// treatment only, which stays a plain CSS shape on purpose: those pins say
// "something is here that you have not caught", and giving them a glyph would
// dress up an identification the layer does not claim to have.
const pinIcon = (variant) =>
  L.divIcon({
    className: `map-pin map-pin-${variant}`,
    html: '<span class="map-pin-shape"></span>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12],
  })

const ICONS = {
  // Two greys, not one. An observation identified to species is something you
  // can go and find; one identified only to genus or family is a lead. Both
  // read as "not yours yet" against the solid catch and threat pins.
  unknown_species: pinIcon('unknown'),
  unknown_coarse: pinIcon('unknown-coarse'),
}

/**
 * iNaturalist's rank vocabulary is long (form, variety, subspecies, section,
 * …). The only distinction this map draws is "pinned to a species" versus
 * "pinned to something broader", so anything not species-or-finer gets the
 * vaguer icon rather than an icon per rank nobody can tell apart at 20px.
 */
const SPECIES_RANKS = new Set(['species', 'subspecies', 'variety', 'form', 'hybrid'])

const unknownIcon = (rank) =>
  SPECIES_RANKS.has(String(rank ?? '').toLowerCase()) ? ICONS.unknown_species : ICONS.unknown_coarse

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
    <Marker
      key={c.id}
      position={[c.lat, c.lng]}
      // Bucketed from the scientific_name already on the row — no lookup, and
      // so no per-marker request. See taxonCategory.js for why the genus is the
      // only taxonomy a catch row carries.
      icon={categoryIcon(c.type, taxonToIconCategory(c))}
    >
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

// ---------------------------------------------------------------------------
// Nearby unknown plants
// ---------------------------------------------------------------------------

// How long the map has to sit still before we ask what is here.
//
// Settle-based, not throttled: a drag across three counties fires a stream of
// moveend events and must cost exactly one request, made when the user stops.
// Every timer started before the last one is cancelled, never fired.
//
// 900ms rather than 500ms because 500 put a determined panner at ~77 calls a
// minute, over iNaturalist's ~60/min courtesy ceiling. The settle is the only
// one of the three guards that bites when every viewport is new ground — the
// grid cache cannot help someone who keeps panning somewhere they have never
// been. It is still short enough to feel like a consequence of stopping.
const SETTLE_MS = 900

/**
 * How far the map must move before a pan is worth a new request, as a fraction
 * of the current viewport radius.
 *
 * The settle timer stops us asking *during* a gesture; this stops us asking
 * after gestures that did not change the question. Nudging the map a few
 * hundred metres returns very nearly the same species — the box we ask about is
 * snapped to a ~1km grid server-side anyway — so at half a viewport radius the
 * results are still substantially the ones already on screen.
 *
 * Zoom is deliberately not gated: changing zoom changes the radius, and a
 * request for a different radius is a genuinely different question even from
 * dead centre.
 */
const MIN_MOVE_FRACTION = 0.5

/**
 * Below this the layer switches itself off.
 *
 * A world view's "nearby" is a contradiction — the server clamps its radius to
 * 50km, so a zoomed-out map would show a tight clump of pins around the centre
 * and nothing else, which reads as "these are the only plants on the continent".
 * Saying "zoom in" is both more honest and free.
 */
const MIN_UNKNOWN_ZOOM = 9

/** axios reports an aborted request as a rejection; it is not a failure. */
const isAborted = (err) => err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError'

/**
 * Plants observed around the current viewport that this user has not caught.
 *
 * Additive and never load-bearing: every failure path here ends in an empty
 * layer and a console warning. The catch markers, the region strip and the map
 * itself do not know this component exists, and a rate-limited iNaturalist must
 * not be able to take them down with it.
 *
 * Lives inside <MapContainer> because that is the only place the Leaflet map
 * instance exists — it needs the viewport to know what to ask about.
 */
/** Centre to corner, so the circle we ask about covers the rectangle shown. */
const viewportRadiusKm = (target) =>
  Math.max(1, target.distance(target.getCenter(), target.getBounds().getNorthEast()) / 1000)

function NearbyUnknownLayer({ enabled, onStatus, onPick }) {
  const [rows, setRows] = useState([])
  const settleTimer = useRef(null)
  const inFlight = useRef(null)
  // Where the last request was actually made from. Not the last place the map
  // stopped — the gate below has to measure drift from what is on screen, and
  // counting suppressed moves as movement would let a hundred small pans add
  // up to nothing while never triggering a fetch.
  const lastFetch = useRef(null)
  const map = useMap()

  const load = useCallback(
    (target) => {
      // Whatever is in flight is about a viewport the user has left.
      inFlight.current?.abort()

      if (target.getZoom() < MIN_UNKNOWN_ZOOM) {
        setRows([])
        lastFetch.current = null
        onStatus({ state: 'zoomed-out' })
        return
      }

      const controller = new AbortController()
      inFlight.current = controller

      const center = target.getCenter()
      const radiusKm = viewportRadiusKm(target)
      lastFetch.current = { center, zoom: target.getZoom() }

      onStatus({ state: 'loading' })

      getNearbyObservations(
        { lat: center.lat, lng: center.lng, radiusKm, userId: getUserId() },
        { signal: controller.signal },
      )
        .then((data) => {
          setRows(data.results ?? [])
          onStatus({
            state: 'ready',
            shown: data.results?.length ?? 0,
            total: data.totalResults ?? 0,
            capped: Boolean(data.capped),
            excludedCaught: data.excludedCaught ?? 0,
          })
        })
        .catch((err) => {
          if (isAborted(err)) return
          // Deliberately swallowed. This layer is a bonus; the map is the page.
          console.warn('[map] nearby unknown plants unavailable:', err?.message ?? err)
          setRows([])
          onStatus({ state: 'failed' })
        })
    },
    [onStatus],
  )

  /**
   * Has the map moved enough since the last request to be asking something new?
   *
   * True for the first move, for any zoom change, and for a pan of more than
   * MIN_MOVE_FRACTION of the viewport radius. False for the small settling
   * nudges that otherwise turn one look around into a stream of near-identical
   * requests.
   *
   * A suppressed move leaves any timer already pending alone rather than
   * cancelling it: that timer belongs to an earlier move that *did* clear the
   * gate, and it reads the live viewport when it fires, so it will fetch the
   * position the user actually ended up in.
   */
  const worthFetching = useCallback((target) => {
    const previous = lastFetch.current
    if (!previous) return true
    if (previous.zoom !== target.getZoom()) return true

    const movedKm = target.distance(previous.center, target.getCenter()) / 1000
    return movedKm >= viewportRadiusKm(target) * MIN_MOVE_FRACTION
  }, [])

  const schedule = useCallback(
    (target) => {
      if (!worthFetching(target)) return
      clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => load(target), SETTLE_MS)
    },
    [load, worthFetching],
  )

  // `event.target` is the map, which avoids capturing the instance returned by
  // this same call in its own handlers.
  useMapEvents({
    moveend: (event) => enabled && schedule(event.target),
    zoomend: (event) => enabled && schedule(event.target),
  })

  useEffect(() => {
    if (!enabled) {
      clearTimeout(settleTimer.current)
      inFlight.current?.abort()
      lastFetch.current = null
      setRows([])
      return undefined
    }

    // Immediately on switch-on: the user just asked for this layer, and making
    // them nudge the map to trigger the first fetch would look broken.
    load(map)

    return () => {
      clearTimeout(settleTimer.current)
      inFlight.current?.abort()
    }
  }, [enabled, load, map])

  if (!enabled) return null

  return rows.map((row) => (
    <Marker
      key={row.observationId ?? `${row.taxonId}:${row.lat},${row.lng}`}
      position={[row.lat, row.lng]}
      icon={unknownIcon(row.rank)}
    >
      <Popup>
        <strong>{row.commonName ?? row.scientificName ?? 'Unidentified plant'}</strong>
        {row.commonName && row.scientificName && (
          <>
            <br />
            <em>{row.scientificName}</em>
          </>
        )}
        <br />
        <span className="map-popup-unknown">
          Not in your catalogue{row.observedOn ? ` · seen ${row.observedOn}` : ''}
        </span>
        <br />
        <button type="button" className="map-popup-action" onClick={() => onPick(row)}>
          Go catch this
        </button>
      </Popup>
    </Marker>
  ))
}

/**
 * The layer switch.
 *
 * Catches are not toggleable — they are the map's subject, and a map of nothing
 * is not a state worth offering. Only the additive layer gets a switch.
 */
function LayerToggle({ showUnknown, onToggle, caption }) {
  return (
    <div className="map-layers">
      <label className="map-layer-toggle">
        <input type="checkbox" checked={showUnknown} onChange={(e) => onToggle(e.target.checked)} />
        <span>Nearby unknown plants</span>
      </label>
      {caption && <span className="capture-muted map-layer-caption">{caption}</span>}
    </div>
  )
}

/**
 * A legend entry drawn with the same markup as the marker it explains.
 *
 * `dangerouslySetInnerHTML` because the SVG is a string — it has to be, since
 * Leaflet takes marker artwork as HTML. The string is a template literal built
 * from module constants in markerIcons.js with nothing user-supplied anywhere
 * in it, so there is no injection surface here; the alternative is a second,
 * JSX copy of every glyph that would drift from the first.
 */
function LegendMark({ type, category }) {
  return (
    <span
      className="map-legend-mark"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: legendSvg(type, category) }}
    />
  )
}

/**
 * Two readings of the same markers, because they carry two independent facts.
 *
 * The frame says whether a record is a catch or a threat report; the glyph says
 * what kind of plant it is. Listing all twelve combinations would be a wall —
 * so the first row explains the frames, using the unknown glyph so nothing in
 * it suggests a category, and the second explains the glyphs on the catch
 * frame, since that is the one most pins wear.
 */
function MapLegend({ showUnknown }) {
  return (
    <div className="capture-muted map-legend">
      <p className="map-legend-row">
        <span className="map-legend-item">
          <LegendMark type="catch" category="unknown" /> Catch
        </span>
        <span className="map-legend-item">
          <LegendMark type="threat_report" category="unknown" /> Threat report
        </span>
        {showUnknown && (
          <span className="map-legend-item">
            <span className="map-swatch map-swatch-unknown" aria-hidden="true" /> Not caught yet
          </span>
        )}
      </p>
      <p className="map-legend-row">
        {LEGEND_CATEGORIES.map(({ category, label }) => (
          <span className="map-legend-item" key={category}>
            <LegendMark type="catch" category={category} /> {label}
          </span>
        ))}
      </p>
    </div>
  )
}

/** What the toggle says about itself underneath. Null when there is nothing to add. */
function captionFor(showUnknown, status) {
  if (!showUnknown) return null

  switch (status?.state) {
    case 'loading':
      return 'Looking…'
    case 'zoomed-out':
      return 'Zoom in to see what is growing nearby.'
    case 'failed':
      // Named, but not as an error: nothing the user did caused this and
      // nothing they can do fixes it.
      return 'Nearby plants are unavailable right now.'
    case 'ready': {
      if (status.shown === 0) {
        return status.excludedCaught > 0
          ? `You have caught all ${status.excludedCaught} species recorded around here.`
          : 'No uncaught plants recorded around here.'
      }
      const shown = status.capped ? `${status.shown} of ${status.total}` : `${status.shown}`
      const caught = status.excludedCaught > 0 ? ` · ${status.excludedCaught} already caught` : ''
      return `${shown} nearby you have not caught${caught}`
    }
    default:
      return null
  }
}

export default function MapView() {
  const navigate = useNavigate()
  const [showUnknown, setShowUnknown] = useState(false)
  const [unknownStatus, setUnknownStatus] = useState(null)
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

      <LayerToggle
        showUnknown={showUnknown}
        onToggle={(next) => {
          setShowUnknown(next)
          if (!next) setUnknownStatus(null)
        }}
        caption={captionFor(showUnknown, unknownStatus)}
      />

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
          <NearbyUnknownLayer
            enabled={showUnknown}
            onStatus={setUnknownStatus}
            onPick={(row) => {
              // Into the capture flow with the pin's coordinates. The capture
              // flow decides what to do with them (see PhotoCapture) — this
              // just hands over what the user tapped.
              navigate('/capture', {
                state: {
                  prefill: {
                    location: { lat: row.lat, lng: row.lng },
                    from: 'map-unknown',
                    scientificName: row.scientificName,
                    commonName: row.commonName,
                  },
                },
              })
            }}
          />
        </MapContainer>
      )}

      <MapLegend showUnknown={showUnknown} />
    </section>
  )
}
