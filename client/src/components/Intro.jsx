import plantIcon from '../resources/icons8-plant-48.png'
import '../css/Intro.css'

/**
 * Full-screen splash shown while a view is loading. Timing (when it mounts,
 * when it's replaced) is owned by the parent — this only renders and lets
 * CSS animate itself in/out over --intro-duration.
 */
export default function Intro({ label = 'Memoflora', durationMs = 800 }) {
  return (
    <div className="intro" style={{ '--intro-duration': `${durationMs}ms` }}>
      <div className="intro__content">
        <img className="intro__icon" src={plantIcon} alt="" aria-hidden="true" />
        <span className="intro__label">{label}</span>
      </div>
    </div>
  )
}
