/**
 * Social — leaderboard, plus shells for the features that follow it.
 *
 * Takes the Region dashboard's slot in the tab bar. The leaderboard is the only
 * section here with a real design behind it; Friends, Daily Challenges and
 * Quests are visual shells so the page has a shape to grow into, and are
 * deliberately not backed by an invented data model.
 */

/**
 * Placeholder standings. NOT REAL DATA.
 *
 * There is no leaderboard endpoint: the server can return one user's totals
 * (GET /api/users/:userId) but has nothing that ranks users against each other,
 * and no client-side aggregation can invent that. These rows exist so the
 * layout can be designed and reviewed now.
 *
 * TODO: backend not built yet — needs GET /api/leaderboard returning
 * { userId, displayName, totalPoints, uniqueSpeciesCount }[] ranked by points.
 * Swap this constant for that call; the row markup below already matches the
 * shape the profile endpoint uses.
 */
const PLACEHOLDER_STANDINGS = [
  { userId: 'placeholder-1', displayName: 'Fern Gully', totalPoints: 1840, uniqueSpeciesCount: 42 },
  { userId: 'placeholder-2', displayName: 'Mossy Log', totalPoints: 1610, uniqueSpeciesCount: 38 },
  { userId: 'placeholder-3', displayName: 'Salal Scout', totalPoints: 1395, uniqueSpeciesCount: 31 },
  { userId: 'placeholder-4', displayName: 'Cedar Wren', totalPoints: 1120, uniqueSpeciesCount: 27 },
  { userId: 'placeholder-5', displayName: 'Trillium', totalPoints: 940, uniqueSpeciesCount: 22 },
]

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
  return (
    <div className="social">
      <h2>Social</h2>

      <section className="social-section">
        <h3>Leaderboard</h3>

        <ol className="leaderboard">
          {PLACEHOLDER_STANDINGS.map((entry, i) => (
            <li key={entry.userId} className={`leader-row${i === 0 ? ' is-first' : ''}`}>
              <span className="leader-rank" aria-hidden="true">
                {i + 1}
              </span>
              <span className="leader-avatar" aria-hidden="true" />
              <span className="leader-name">
                {entry.displayName}
                <span className="leader-meta">{entry.uniqueSpeciesCount} species</span>
              </span>
              <span className="leader-points">{entry.totalPoints.toLocaleString()}</span>
            </li>
          ))}
        </ol>
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
