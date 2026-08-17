import { useEffect, useState } from 'react'

import { getLeaderboard } from '../api'

/**
 * Social — leaderboard, plus shells for the features that follow it.
 *
 * Takes the Region dashboard's slot in the tab bar. The leaderboard is the only
 * section here with a real design behind it; Friends, Daily Challenges and
 * Quests are visual shells so the page has a shape to grow into, and are
 * deliberately not backed by an invented data model.
 */

/** A section that has its chrome but no data behind it yet. */
function EmptySection({ title, icon, children }) {
  return (
    <section className="social-section">
      <h3>{title}</h3>
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">
          {icon}
        </span>
        <p>{children}</p>
      </div>
    </section>
  )
}

export default function SocialView() {
  const [standings, setStandings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    getLeaderboard()
      .then((rows) => {
        if (!cancelled) setStandings(rows ?? [])
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

  return (
    <div className="social">
      <h2>Social</h2>

      <section className="social-section">
        <h3>Leaderboard</h3>

        {loading && <p className="capture-muted">Loading standings…</p>}
        {!loading && error && <p className="capture-note">{error}</p>}
        {!loading && !error && standings.length === 0 && (
          <p className="capture-note">
            Nobody has scored yet. Catch something from the Capture tab to take first place.
          </p>
        )}

        {standings.length > 0 && (
          <ol className="leaderboard">
            {standings.map((entry, i) => (
              <li key={entry.userId} className={`leader-row${i === 0 ? ' is-first' : ''}`}>
                <span className="leader-rank" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="leader-avatar" aria-hidden="true" />
                <span className="leader-name">
                  {entry.displayName ?? 'Explorer'}
                  <span className="leader-meta">{entry.uniqueSpeciesCount} species</span>
                </span>
                <span className="leader-points">{entry.totalPoints.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* TODO: backend not built yet. Friends, challenges and quests each need
          their own schema and endpoints, and inventing one here would commit
          the app to a data model nobody has scoped. Shells only. */}
      <EmptySection title="Friends" icon="👥">
        Add friends to see what they have been finding. Not built yet.
      </EmptySection>

      <EmptySection title="Daily Challenges" icon="🎯">
        A new goal each day — photograph a flower, log a species you have never
        caught. Not built yet.
      </EmptySection>

      <EmptySection title="Quests" icon="🧭">
        Longer collections to work through at your own pace. Not built yet.
      </EmptySection>
    </div>
  )
}
