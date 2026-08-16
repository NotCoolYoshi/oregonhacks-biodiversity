import { useEffect, useState } from 'react'

import { getCatches } from '../api'
import { groupBySpecies } from '../catalogue'
import { getUserId } from '../session'

// TODO: the "catchable nearby" list from GET /api/region/:placeId/nearby, to
// show un-caught silhouettes alongside what has been found. Phenology
// (GET /api/species/:taxonId/phenology) drives "in season" badges.

/**
 * Species milestones.
 *
 * Counted client-side off the catches already on screen — no invented
 * endpoint, no badge table. The thresholds themselves are a guess and the UI
 * says so.
 *
 * TODO: backend not built yet. Real badges need their own model (what unlocks
 * one, when it was earned, whether it is retired) and none of that can be
 * derived from the catch list. This is the display, not the feature.
 */
const MILESTONES = [
  { threshold: 1, label: 'First find', icon: '🌱' },
  { threshold: 5, label: 'Five species', icon: '🍃' },
  { threshold: 15, label: 'Fifteen species', icon: '🌲' },
  { threshold: 30, label: 'Thirty species', icon: '🏔️' },
]

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * One species, front and back.
 *
 * A <button> rather than a div with a click handler: the whole point is that it
 * is activatable, and that has to reach the keyboard and the a11y tree. Both
 * faces stay in the DOM, so `aria-pressed` plus real text on each side is
 * enough — no aria-live, no swapping content out from under a screen reader.
 */
function SpeciesCard({ species }) {
  const [flipped, setFlipped] = useState(false)
  const isThreat = species.type === 'threat_report'

  return (
    <button
      type="button"
      className={`species-card${flipped ? ' is-flipped' : ''}${isThreat ? ' is-threat' : ''}`}
      aria-pressed={flipped}
      onClick={() => setFlipped((f) => !f)}
    >
      <span className="species-card-inner">
        <span className="species-face species-front">
          <span className="species-icon" aria-hidden="true">
            {isThreat ? '⚠️' : '🌿'}
          </span>
          <span className="species-name">
            {species.common_name ?? species.scientific_name}
          </span>
          <span className="species-count">
            {species.sightings === 1 ? '1 sighting' : `${species.sightings} sightings`}
          </span>
        </span>

        <span className="species-face species-back">
          <span className="species-sci">{species.scientific_name}</span>
          <span className="species-meta">
            {isThreat ? 'Threat report' : 'Native catch'}
          </span>
          <span className="species-meta">First logged {formatDate(species.firstSeen)}</span>
        </span>
      </span>
    </button>
  )
}

function MilestoneBar({ milestone, count }) {
  const unlocked = count >= milestone.threshold
  const progress = Math.min(count / milestone.threshold, 1)

  return (
    <li className={`milestone${unlocked ? ' is-unlocked' : ''}`}>
      <span className="milestone-icon" aria-hidden="true">
        {milestone.icon}
      </span>
      <span className="milestone-body">
        <span className="milestone-label">
          {milestone.label}
          <span className="milestone-count">
            {Math.min(count, milestone.threshold)}/{milestone.threshold}
          </span>
        </span>
        {/* The bar is decoration over the count beside it, which is the real
            accessible reading — hence aria-hidden rather than a progressbar
            role duplicating the same number. */}
        <span className="milestone-track" aria-hidden="true">
          <span className="milestone-fill" style={{ transform: `scaleX(${progress})` }} />
        </span>
      </span>
    </li>
  )
}

export default function CatalogueView() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    getCatches({ userId: getUserId() })
      .then((data) => {
        if (!cancelled) setRows(data ?? [])
      })
      .catch((err) => {
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

  const species = groupBySpecies(rows)
  const caught = species.filter((s) => s.type !== 'threat_report').length

  return (
    <div className="catalogue">
      <h2>Catalogue</h2>

      {loading && <p className="capture-muted">Loading your catalogue…</p>}
      {!loading && error && <p className="capture-note">{error}</p>}

      {!loading && !error && species.length === 0 && (
        <p className="capture-note">
          Nothing catalogued yet. Photograph a plant from the Capture tab to start.
        </p>
      )}

      {species.length > 0 && (
        <>
          <p className="capture-muted">Tap a card to see the details.</p>
          <div className="species-grid">
            {species.map((s) => (
              <SpeciesCard key={s.taxon_id} species={s} />
            ))}
          </div>
        </>
      )}

      <section className="catalogue-section">
        <div className="social-section-head">
          <h3>Badges collected</h3>
          <span className="badge-placeholder">Provisional</span>
        </div>
        <ul className="milestones">
          {MILESTONES.map((m) => (
            <MilestoneBar key={m.threshold} milestone={m} count={caught} />
          ))}
        </ul>
      </section>

      {/* TODO: backend not built yet. Quests need their own schema and
          endpoints — see the matching shell on the Social page. */}
      <section className="catalogue-section">
        <h3>Completed quests</h3>
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            🧭
          </span>
          <p>Finished quests will collect here. Not built yet.</p>
        </div>
      </section>
    </div>
  )
}
