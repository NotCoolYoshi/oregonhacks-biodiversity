import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import UserProfile from '../components/UserProfile'
import Intro from '../components/Intro'
import { getRegionScore } from '../api'

const PLACE_ID = 10
const INTRO_DURATION_MS = 1500

export default function HomeView() {
  const navigate = useNavigate()
  const [score, setScore] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showIntro, setShowIntro] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setShowIntro(false), INTRO_DURATION_MS)
    return () => clearTimeout(timer)
  }, [])

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
    <>
      {showIntro && <Intro durationMs={INTRO_DURATION_MS} />}
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
          <div className="action-card action-capture" onClick={() => navigate('/capture')}>
            <div className="action-icon">📸</div>
            <h3>Capture</h3>
            <p>Identify a plant from a photo</p>
          </div>

          <div className="action-card action-catalogue" onClick={() => navigate('/catalogue')}>
            <div className="action-icon">📖</div>
            <h3>Catalogue</h3>
            <p>View native species you found</p>
          </div>

          <div className="action-card action-map" onClick={() => navigate('/map')}>
            <div className="action-icon">🗺️</div>
            <h3>Map</h3>
            <p>See recent captures nearby</p>
          </div>

          <div className="action-card action-social" onClick={() => navigate('/social')}>
            <div className="action-icon">🏆</div>
            <h3>Social</h3>
            <p>Leaderboard, friends and quests</p>
          </div>
        </section>
      </div>
    </div>
    </>
  )
}


