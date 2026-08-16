import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import UserProfile from '../UserProfile'
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
        <UserProfile />
      </div>

      <div className="home-tip">
        <span className="tip-icon">🌿</span>
        <p>Tips: Take clear photos of leaves or flowers for better ID results!</p>
        <button className="tip-close" aria-label="Close">×</button>
      </div>

      <div className="home-content">
        <section className="home-section">
          <h2>Welcome to Biodiversity</h2>
          <p className="home-description">
            Photograph a plant and find out what it is — then find out whether it 
            belongs here. Native species go to your dex, invasive species become threat reports.
          </p>
        </section>

        {!loading && score && (
          <section className="home-section">
            <h3>Regional Biodiversity Score</h3>
            <div className="score-display">
              <div className="score-value">{Math.round((score.health_score ?? 0) * 100)}%</div>
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

          <div className="action-card action-dex" onClick={() => navigate('/dex')}>
            <div className="action-icon">📖</div>
            <h3>Dex</h3>
            <p>View native species you found</p>
          </div>

          <div className="action-card action-map" onClick={() => navigate('/map')}>
            <div className="action-icon">🗺️</div>
            <h3>Map</h3>
            <p>See recent captures nearby</p>
          </div>

          <div className="action-card action-region" onClick={() => navigate('/region')}>
            <div className="action-icon">📊</div>
            <h3>Region</h3>
            <p>Regional biodiversity dashboard</p>
          </div>
        </section>
      </div>
    </div>
  )
}
