import { useCallback, useEffect, useState } from 'react'

import { getCatches, getUserAchievements } from '../api'
import { groupBySpecies } from '../catalogue'
import { getUserId } from '../session'
import SpeciesDetail from './SpeciesDetail'

// TODO: the "catchable nearby" list from GET /api/region/:placeId/nearby, to
// show un-caught silhouettes alongside what has been found. Phenology
// (GET /api/species/:taxonId/phenology) drives "in season" badges.

/**
 * Decorative only. Thresholds, labels, and unlock state all come from
 * GET /api/users/:userId/achievements — this just picks an emoji for a label
 * the server already named, keyed the same way so a badge added there shows
 * up here with a plain fallback rather than breaking.
 */
const BADGE_ICONS = {
  'First Seed': '🌱',
  'Tender Sprout': '🌿',
  'Budding Grace': '🌸',
  "Petal's Promise": '🌺',
  'In Full Bloom': '🌻',
  'Verdant Bloom': '🌳',
  'Keeper of the Garden': '🏵️',
  'First Watch': '👀',
  'Vigilant Hand': '✋',
  'Warden of the Wild': '🛡️',
  'Guardian of the Grove': '⚔️',
}
const DEFAULT_BADGE_ICON = '🎖️'

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * One species, front and back.
 *
 * A <button> rather than a div with a click handler: the whole point is that it
 * is activatable, and that has to reach the keyboard and the a11y tree. Both
 * faces stay in the DOM, so real text on each side is enough — no aria-live, no
 * swapping content out from under a screen reader.
 *
 * The flip is now hover/focus decoration rather than the click action; clicking
 * opens the full view. Two different things on one tap was always going to lose,
 * and the back face only ever held three lines the expanded view now covers.
 */
function SpeciesCard({ species, onOpen }) {
  const isThreat = species.type === 'threat_report'
  const photo = species.catches.find((c) => c.photo_url)?.photo_url ?? null

  return (
    <button
      type="button"
      className={`species-card${isThreat ? ' is-threat' : ''}`}
      onClick={onOpen}
    >
      <span className="species-card-inner">
        <span className="species-face species-front">
          {/* The user's own photo when there is one, which is the entire
              appeal of a collection. The emoji stands in for catches logged
              before photo storage existed. */}
          {photo ? (
            <span className="species-thumb" style={{ backgroundImage: `url(${photo})` }} />
          ) : (
            <span className="species-icon" aria-hidden="true">
              {isThreat ? '⚠️' : '🌿'}
            </span>
          )}
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

/**
 * One badge row. `badge` is a { threshold, label, unlocked } from
 * GET /api/users/:userId/achievements — `unlocked` is the server's word on
 * it, not recomputed here. `count` is only for the progress display (how
 * close to *this* threshold), so it stays in sync even for an already-
 * unlocked badge that a later one hasn't caught up to.
 */
function MilestoneBar({ badge, count }) {
  const progress = Math.min(count / badge.threshold, 1)

  return (
    <li className={`milestone${badge.unlocked ? ' is-unlocked' : ''}`}>
      <span className="milestone-icon" aria-hidden="true">
        {BADGE_ICONS[badge.label] ?? DEFAULT_BADGE_ICON}
      </span>
      <span className="milestone-body">
        <span className="milestone-label">
          {badge.label}
          <span className="milestone-count">
            {Math.min(count, badge.threshold)}/{badge.threshold}
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
  // Everyone's catches, for the expanded view's "nearby threat reports". Same
  // endpoint the map reads, unfiltered — no new route for data already served.
  const [allCatches, setAllCatches] = useState([])
  // Native/invasive badge state from the server — null while loading or if the
  // request failed. Never computed from `rows`: the server counts distinct
  // species server-side, and duplicating that here would be a second place to
  // keep in sync with GET /api/users/:userId/achievements.
  const [achievements, setAchievements] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openTaxonId, setOpenTaxonId] = useState(null)

  useEffect(() => {
    let cancelled = false
    const userId = getUserId()

    Promise.all([
      getCatches({ userId }),
      // Only feeds the nearby-threats list inside a card, so a failure here
      // costs one section of one dialog. Resolving to [] keeps it from taking
      // the catalogue down with it.
      getCatches().catch(() => []),
      // Same degradation: a failed badge fetch costs one section, not the
      // whole page.
      getUserAchievements(userId).catch(() => null),
    ])
      .then(([mine, everyone, badges]) => {
        if (cancelled) return
        setRows(mine ?? [])
        setAllCatches(everyone ?? [])
        setAchievements(badges)
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

  const closeDetail = useCallback(() => setOpenTaxonId(null), [])

  const species = groupBySpecies(rows)
  const open = species.find((s) => s.taxon_id === openTaxonId) ?? null
  const ownIds = new Set(rows.map((row) => row.id))

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
          <p className="capture-muted">Tap a card to see every sighting.</p>
          <div className="species-grid">
            {species.map((s) => (
              <SpeciesCard
                key={s.taxon_id}
                species={s}
                onOpen={() => setOpenTaxonId(s.taxon_id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Keyed by species so switching cards remounts rather than reuses —
          each one fetches its own status, and a stale one showing under a new
          name is worse than a second spinner. */}
      {open && (
        <SpeciesDetail
          key={open.taxon_id}
          species={open}
          allCatches={allCatches}
          ownIds={ownIds}
          onClose={closeDetail}
        />
      )}

      <section className="catalogue-section">
        <div className="social-section-head">
          <h3>Badges collected</h3>
        </div>
        {!achievements ? (
          <p className="capture-muted">
            {loading ? 'Loading badges…' : 'Could not load badges right now.'}
          </p>
        ) : (
          <>
            <h4 className="milestones-subhead">Native species</h4>
            <ul className="milestones">
              {achievements.nativeBadges.map((badge) => (
                <MilestoneBar
                  key={badge.threshold}
                  badge={badge}
                  count={achievements.nativeSpeciesCount}
                />
              ))}
            </ul>

            <h4 className="milestones-subhead">Invasive reports</h4>
            <ul className="milestones">
              {achievements.invasiveBadges.map((badge) => (
                <MilestoneBar
                  key={badge.threshold}
                  badge={badge}
                  count={achievements.invasiveSpeciesCount}
                />
              ))}
            </ul>
          </>
        )}
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
