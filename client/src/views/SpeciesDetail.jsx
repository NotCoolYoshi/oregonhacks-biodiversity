import { useEffect, useRef, useState } from 'react'

import { getSpeciesStatus, resolvePlace } from '../api'
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

// ---------------------------------------------------------------------------
// Reconciling stored history against a live lookup
//
// Two sources describe the same catch and can legitimately disagree:
//
//   stored  what was written to the row when the catch was logged
//   live    what iNaturalist says today for the row's coordinates
//
// They diverge for two different reasons, and both are real. Rows logged
// before the verdict became location-aware were classified against a fixed
// place id, so their stored answer may simply be wrong. And even for correct
// rows, iNaturalist revises assessments and redraws places.
//
// The rule everywhere below: prefer live, fall back to stored while the lookup
// is in flight or has failed, and when the two disagree *say so* rather than
// quietly picking a winner. A card that silently contradicts itself is the bug
// this replaces; a card that silently overwrites history would be a worse one.
// ---------------------------------------------------------------------------

/**
 * What a stored `type` actually tells us, which is less than it looks.
 *
 * classify() files a species with no checklist entry as 'catch' alongside
 * genuinely-native ones, so a stored 'catch' cannot be reported as "Native" —
 * that conflation is what produced the "Native header, unknown body" card.
 * These labels describe what the row *records*, not what the species *is*.
 */
const STORED_LABEL = {
  catch: 'In your catalogue',
  threat_report: 'Reported as a threat',
}

/** The same fact as a phrase, for "Logged as ___ on <date>". */
const STORED_PHRASE = {
  catch: 'a catch',
  threat_report: 'a threat report',
}

/**
 * What a live lookup says, using the server's own three-way vocabulary:
 * `isNative` is true, false, or null-for-unknown — the third case being the
 * one a binary catch/threat flag cannot express.
 */
function liveLabel(status) {
  if (status.isInvasive) return { label: 'Invasive here', tone: 'is-threat' }
  if (status.isNative) return { label: 'Native here', tone: 'is-native' }
  return { label: 'Not on the local checklist', tone: 'is-unknown' }
}

/**
 * Decide what the card says about native vs invasive, right now.
 *
 * @returns {{ state, label, tone, storedLabel? }}
 *   checking   lookup in flight — stored shown, marked provisional
 *   unchecked  lookup failed — stored shown, and said to be historical
 *   agreed     live matches stored — live shown, no ceremony
 *   diverged   live contradicts stored — live shown, disagreement disclosed
 */
function reconcileVerdict({ storedType, status, loading }) {
  const storedLabel = STORED_LABEL[storedType] ?? 'In your catalogue'
  const storedTone = storedType === 'threat_report' ? 'is-threat' : 'is-native'

  if (loading) return { state: 'checking', label: storedLabel, tone: storedTone }
  if (!status) return { state: 'unchecked', label: storedLabel, tone: storedTone }

  const { label, tone } = liveLabel(status)
  const agrees = status.classification === storedType

  return agrees
    ? { state: 'agreed', label, tone }
    : { state: 'diverged', label, tone, storedLabel, storedPhrase: STORED_PHRASE[storedType] }
}

/**
 * Decide what a single sighting says about where it happened.
 *
 * Compared by place id, never by name: a row written before the fix carries
 * "Oregon" from the old three-entry lookup table while a fresh resolution
 * returns "Oregon, US" from iNaturalist. Those are the same place spelled two
 * ways, and treating that as a disagreement would cry wolf on every correct
 * row in the database.
 */
function reconcilePlace({ sighting, live }) {
  const storedName = sighting.place_name ?? null

  if (!live) return { state: 'stored', name: storedName }

  const samePlace = Number(sighting.place_id) === Number(live.placeId)
  if (samePlace) {
    // Same place, possibly a tidier name. Show the current one; there is
    // nothing to disclose because nothing actually moved.
    return { state: 'refreshed', name: live.placeName }
  }

  return { state: 'diverged', name: live.placeName, storedName }
}

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
function SightingCard({ sighting, livePlace }) {
  const season = seasonOf(sighting.created_at, sighting.lat)
  const coords = formatCoords(sighting)
  const place = reconcilePlace({ sighting, live: livePlace })

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
        <span className="sighting-place">{place.name ?? 'Location not recorded'}</span>
        {/* The row says one place and a fresh resolution of its own
            coordinates says another — which is exactly what a catch logged
            before the verdict became location-aware looks like. Both are
            shown; neither is quietly dropped. */}
        {place.state === 'diverged' && (
          <span className="sighting-corrected">
            Logged as {place.storedName ?? 'no place'}
          </span>
        )}
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
  // sighting id -> freshly resolved place. Empty until the lookups land, which
  // is why reconcilePlace treats "no live answer" as "show what was stored".
  const [livePlaces, setLivePlaces] = useState(new Map())

  const sightings = [...species.catches].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )

  // The sighting the live verdict is about: the most recent one that has
  // coordinates to ask about. Everything reconciled below is anchored here.
  const anchor = sightings.find(hasLocation) ?? null

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
  //
  // Anchored to one specific sighting rather than to the species as a whole,
  // so the live answer and the stored answer are about the same event. The
  // header used to read the grouped card's type while the body read a lookup
  // for a possibly-different sighting's coordinates; comparing those two was
  // never apples to apples.
  useEffect(() => {
    let cancelled = false

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
  }, [species.taxon_id, species.scientific_name, anchor?.id])

  // Re-resolve each located sighting's own coordinates, so a stale place_name
  // is never presented as current. One request per sighting looks worse than
  // it is: the unique index caps a user at one catch per species per place, so
  // this is a handful at most, and /places/resolve is cached server-side for a
  // day against coordinates rounded to ~1km.
  useEffect(() => {
    let cancelled = false
    const located = sightings.filter(hasLocation)
    if (located.length === 0) return undefined

    Promise.all(
      located.map((sighting) =>
        resolvePlace({ lat: sighting.lat, lng: sighting.lng })
          .then((place) => [sighting.id, place])
          // A failed or unresolvable coordinate (mid-ocean 404s) just means no
          // live answer for that row, and reconcilePlace falls back to stored.
          .catch(() => [sighting.id, null]),
      ),
    ).then((entries) => {
      if (!cancelled) setLivePlaces(new Map(entries.filter(([, place]) => place)))
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species.taxon_id])

  const threats = nearbyThreats({ allCatches, ownIds, sightings })
  const withPhotos = sightings.filter((s) => s.photo_url).length

  // The single source of truth for what this card says about nativity. Both
  // the header badge and the body text below read it, so they cannot disagree
  // with each other — only, deliberately and visibly, with history.
  const verdict = reconcileVerdict({
    storedType: anchor?.type ?? species.type,
    status,
    loading: loadingStatus,
  })

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

        <div className={`capture-verdict ${verdict.tone}`}>
          <strong>
            {verdict.label}
            {verdict.state === 'checking' && (
              <span className="verdict-checking"> · re-checking…</span>
            )}
          </strong>

          {/* Both header and body now read `verdict`, so the only disagreement
              this card can show is the real one: between what was recorded and
              what iNaturalist says today. */}
          {verdict.state === 'checking' && (
            <p className="capture-muted">
              Showing what was recorded when you logged this, while we check it against
              iNaturalist.
            </p>
          )}

          {verdict.state === 'unchecked' && (
            <p className="capture-muted">
              {statusError ?? 'Could not reach iNaturalist for this species.'} Showing what was
              recorded when you logged this, which may be out of date.
            </p>
          )}

          {status && verdict.state !== 'checking' && (
            <p>
              {species.common_name ?? species.scientific_name} is recorded as{' '}
              <strong>{status.establishmentMeans}</strong> in {status.placeName}.
            </p>
          )}

          {/* The disclosure. Catches logged before the verdict became
              location-aware were classified against a fixed region, so their
              stored answer can be wrong — but iNaturalist also revises
              assessments, so neither side is automatically the mistake. Name
              both and date the old one rather than picking a winner. */}
          {verdict.state === 'diverged' && anchor && (
            <p className="verdict-diverged">
              Logged as <strong>{verdict.storedPhrase}</strong> on{' '}
              {formatDate(anchor.created_at)}. The current lookup says{' '}
              <strong>{status.establishmentMeans}</strong> for this location — species
              assessments and regional checklists can both change.
            </p>
          )}

          {/* A verdict with no coordinates behind it is about the server's
              fallback region, not about anywhere this was actually found. */}
          {status?.placeSource === 'fallback' && (
            <p className="capture-muted">
              This sighting has no coordinates, so the check used {status.placeName} rather
              than where the photo was taken.
            </p>
          )}
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
              <SightingCard
                key={sighting.id}
                sighting={sighting}
                livePlace={livePlaces.get(sighting.id) ?? null}
              />
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
