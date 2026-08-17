import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import UserProfile from '../components/UserProfile'
import EcoFactsPanel from '../components/EcoFactsPanel'
import { getRegionScore } from '../api'

const PLACE_ID = 10

export default function HomeView() {
  const navigate = useNavigate()
  const [score, setScore] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    getRegionScore(PLACE_ID)
      .then((data) => {
        if (mounted) setScore(data)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => (mounted = false)
  }, [])

  return (
    <div className="home">
      <div className="home-header">
        <div className="home-profile-glass">
          <UserProfile />
        </div>
      </div>

      <div className="home-content">
        {/* <section className="home-section">
          <h2>Welcome to Biodiversity</h2>
          <p className="home-description">
            Photograph a plant and find out what it is — then find out whether it 
            belongs here. Native species go to your catalogue, invasive species become threat
            reports.
          </p>
        </section> */}

        {!loading && score && (
          <section className="home-section">
            <h3>Regional Biodiversity Score</h3>
            <div className="score-display">
              {/* `score.score` is already 0-100. This read used to be
                `score.health_score * 100`, a key the endpoint does not return,
                so the panel showed a flat 0% for every region. */}
            <div className="score-value">{score.grade === 'N/A' ? '—' : `${score.score}%`}</div>
              <p className="score-label">Region Health</p>
            </div>
          </section>
        )}

        <section className="home-actions">
          {/* onTouchStart is a no-op handler, not dead code: iOS Safari only
              applies :active styles to an element that has a touch listener
              of its own (or an ancestor's), so without this the glass press
              feedback in App.css (.action-card:active) never fires on a real
              phone tap — only on desktop via :hover/:active from a mouse. */}
          <div
            className="action-card action-capture"
            onClick={() => navigate('/capture')}
            onTouchStart={() => {}}
          >
            <div className="action-icon">📸</div>
            <h3>Capture</h3>
            <p>Identify a plant from a photo</p>
          </div>

          <div
            className="action-card action-catalogue"
            onClick={() => navigate('/catalogue')}
            onTouchStart={() => {}}
          >
            <div className="action-icon">📖</div>
            <h3>Catalogue</h3>
            <p>View native species you found</p>
          </div>

          <div
            className="action-card action-map"
            onClick={() => navigate('/map')}
            onTouchStart={() => {}}
          >
            <div className="action-icon">🗺️</div>
            <h3>Map</h3>
            <p>See recent captures nearby</p>
          </div>

          <div
            className="action-card action-social"
            onClick={() => navigate('/social')}
            onTouchStart={() => {}}
          >
            <div className="action-icon">🏆</div>
            <h3>Social</h3>
            <p>Leaderboard, friends and quests</p>
          </div>
        </section>

        <EcoFactsPanel />
      </div>
    </div>
  )
}
