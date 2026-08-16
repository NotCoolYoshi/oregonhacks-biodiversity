import { useEffect, useRef, useState } from 'react'

import { getSpeciesStatus } from '../api'
import { seasonOf, distanceKm, hasLocation, formatCoords } from '../sighting'

/**
 * The expanded species card: everything known about one species, across every
 * time the user has found it.
 *
 * Built on <dialog> rather than a hand-rolled overlay. showModal() gives us
 * Escape-to-close, focus moved into the dialog and restored on close, the rest
 * of the page marked inert, and a real ::backdrop — all of which a div with
 * position: fixed has to reimplement, usually incompletely.
 */

/** How far from a sighting another user's report still counts as "nearby". */
const NEARBY_RADIUS_KM = 25

/** Threat reports listed at once. Beyond this it stops being a list. */
const MAX_NEARBY = 6

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * Other users' threat reports near where this species was found.
 *
 * Computed from the catch list the page already holds rather than from a new
 * endpoint — GET /api/catches with no userId is what the map reads, and it is
 * the same data. The user's own rows are excluded by id: "nearby threat
 * reports" means what other people have flagged, and the response deliberately
 * carries no user_id to filter on directly.
 */
function nearbyThreats({ allCatches, ownIds, sightings }) {
  const anchors = sightings.filter(hasLocation)
  if (anchors.length === 0) return []

  return allCatches
    .filter((row) => row.type === 'threat_report' && hasLocation(row) && !ownIds.has(row.id))
    .map((row) => ({
      row,
      km: Math.min(...anchors.map((anchor) => distanceKm(anchor, row))),
    }))
    .filter(({ km }) => km <= NEARBY_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_NEARBY)
}

/** One sighting: its photo, where it was taken, when, and in what season. */
function SightingCard({ sighting }) {
  const season = seasonOf(sighting.created_at, sighting.lat)
  const coords = formatCoords(sighting)

  return (
    <li className="sighting">
      {sighting.photo_url ? (
        <img
          className="sighting-photo"
          src={sighting.photo_url}
          alt={`${sighting.common_name ?? sighting.scientific_name}, photographed ${formatDate(sighting.created_at)}`}
          loading="lazy"
        />
      ) : (
        /* Catches logged before photo storage existed. Saying so beats a
           broken image or pretending the sighting did not happen. */
        <div className="sighting-photo is-missing">
          <span aria-hidden="true">🌿</span>
          <span className="sr-only">No photo was stored for this sighting.</span>
        </div>
      )}

      <div className="sighting-meta">
        <span className="sighting-place">
          {sighting.place_name ?? 'Location not recorded'}
        </span>
        {/* A text label rather than an embedded map: one Leaflet instance per
            photo in a grid is a lot of machinery to say "here". */}
        {coords && <span className="sighting-coords">{coords}</span>}
        <span className="sighting-date">
          {formatDate(sighting.created_at)}
          {season && ` · ${season.season}`}
          {/* Without coordinates the hemisphere is an assumption, and a
              northern-hemisphere season stated flatly would be a guess wearing
              a fact's clothes. */}
          {season?.assumedHemisphere && '*'}
        </span>
      </div>
    </li>
  )
}

/**
 * Conservation status.
 *
 * Two different things, deliberately not blended. iNaturalist's
 * `conservationStatus` is a real assessment by a real authority (IUCN and
 * friends) and is shown as such when it exists. The rare/common banding this
 * app's badge system would need is a separate thing that has never been
 * calibrated — there are no thresholds anywhere in the codebase to reuse — so
 * it says so instead of inventing a scale that would read as authoritative.
 */
function ConservationStatus({ status, loading }) {
  if (loading) return <p className="capture-muted">Checking conservation status…</p>

  const assessed = status?.conservationStatus

  return (
    <>
      {assessed?.statusName ? (
        <p>
          <strong>{assessed.statusName}</strong>
          {assessed.authority ? ` — assessed by ${assessed.authority}` : ''}
        </p>
      ) : (
        <p className="capture-muted">
          No conservation assessment on iNaturalist for this species.
        </p>
      )}

      <p className="capture-muted">
        <span className="badge-placeholder">Not calibrated</span> Rare / common banding needs
        thresholds this app has never set. Showing a made-up scale here would read as
        authoritative, so it is left out until the badge system defines one.
      </p>
    </>
  )
}

export default function SpeciesDetail({ species, allCatches, ownIds, onClose }) {
  const dialogRef = useRef(null)
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(null)
  const [loadingStatus, setLoadingStatus] = useState(true)

  const sightings = [...species.catches].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )

  // showModal() rather than the `open` attribute: only the former makes it a
  // real modal — inert background, Escape, focus containment.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  // Native Escape handling fires `cancel`, then `close`. Listening to `close`
  // covers Escape, the close button, and the backdrop alike, so React state
  // and the dialog can never disagree about whether it is open.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [onClose])

  // The verdict text and the conservation assessment, for the region this
  // species was actually found in — the same call the capture screen makes.
  useEffect(() => {
    let cancelled = false
    const anchor = sightings.find(hasLocation)

    getSpeciesStatus(
      species.taxon_id,
      anchor ? { lat: anchor.lat, lng: anchor.lng } : null,
      species.scientific_name,
    )
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch((err) => {
        if (cancelled) return
        setStatusError(
          err?.response?.data?.error ?? 'Could not reach iNaturalist for this species.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false)
      })

    return () => {
      cancelled = true
    }
    // Keyed by species: the dialog is remounted per card, and re-running this
    // on every sighting-array identity change would refetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species.taxon_id, species.scientific_name])

  const threats = nearbyThreats({ allCatches, ownIds, sightings })
  const isThreat = species.type === 'threat_report'
  const withPhotos = sightings.filter((s) => s.photo_url).length

  return (
    <dialog
      ref={dialogRef}
      className="species-detail"
      aria-labelledby="species-detail-title"
      // A click landing on the dialog element itself is a click on the
      // backdrop — the content sits in a child, so anything inside stops here
      // before it ever reaches this handler.
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="species-detail-body">
        <header className="species-detail-head">
          <div>
            <h2 id="species-detail-title">
              {species.common_name ?? species.scientific_name}
            </h2>
            <p className="species-detail-sci">{species.scientific_name}</p>
          </div>
          <button
            type="button"
            className="species-detail-close"
            onClick={() => dialogRef.current?.close()}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div className={`capture-verdict ${isThreat ? 'is-threat' : 'is-native'}`}>
          <strong>{isThreat ? 'Invasive — reported as a threat' : 'Native — in your catalogue'}</strong>
          {loadingStatus && <p className="capture-muted">Checking this species…</p>}
          {status && (
            <p>
              {species.common_name ?? species.scientific_name} is recorded as{' '}
              <strong>{status.establishmentMeans}</strong> in {status.placeName}.
            </p>
          )}
          {statusError && <p className="capture-muted">{statusError}</p>}
        </div>

        <section className="species-detail-section">
          <h3>
            {sightings.length === 1 ? '1 sighting' : `${sightings.length} sightings`}
            {withPhotos < sightings.length && (
              <span className="capture-muted">
                {' '}
                · {sightings.length - withPhotos} without a photo
              </span>
            )}
          </h3>
          <ul className="sighting-grid">
            {sightings.map((sighting) => (
              <SightingCard key={sighting.id} sighting={sighting} />
            ))}
          </ul>
        </section>

        <section className="species-detail-section">
          <h3>Conservation status</h3>
          <ConservationStatus status={status} loading={loadingStatus} />
        </section>

        <section className="species-detail-section">
          <div className="social-section-head">
            <h3>Season &amp; weather</h3>
            <span className="badge-placeholder">Date-derived</span>
          </div>
          {/* The per-sighting season is already on each tile above, so this
              section is the note explaining where it comes from and what is
              missing — not a second copy of the same list. */}
          <p className="capture-muted">
            The season on each sighting is worked out from its date and hemisphere.
            {sightings.some((s) => seasonOf(s.created_at, s.lat)?.assumedHemisphere) &&
              ' Sightings marked * have no coordinates, so the northern hemisphere is assumed.'}
          </p>
          {/* Flagged rather than faked: no weather is captured at submission
              time, so there is nothing to show for past catches and nothing to
              backfill from. */}
          <p className="capture-muted">
            Weather at the time of the catch is not recorded — nothing captures it when a
            photo is submitted, so it cannot be filled in for past catches either. Live
            weather would need a new API integration and a column to store it in.
          </p>
        </section>

        <section className="species-detail-section">
          <h3>Nearby threat reports</h3>
          {threats.length === 0 ? (
            <p className="capture-muted">
              {sightings.some(hasLocation)
                ? `No threat reports from other users within ${NEARBY_RADIUS_KM}km of where you found this.`
                : 'This species has no recorded location, so nearby reports cannot be found.'}
            </p>
          ) : (
            <ul className="threat-list">
              {threats.map(({ row, km }) => (
                <li key={row.id}>
                  <span className="threat-name">{row.common_name ?? row.scientific_name}</span>
                  <span className="capture-muted">
                    {km < 1 ? '<1' : Math.round(km)}km away · {formatDate(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  )
}
