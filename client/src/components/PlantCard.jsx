import { useState, useRef } from 'react'
import '../css/PlantCard.css'

const EMPTY_PLANT = {
  name: null,
  uniqueId: null,
  photoUrl: null,
  rarity: null,
}

// Valid rarity/rank values
const VALID_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR']

/**
 * Get a safe rarity value that corresponds to a defined CSS variable.
 * Defaults to 'N' if the value is missing or invalid.
 */
function getRarityValue(rarity) {
  if (!rarity || !VALID_RARITIES.includes(rarity)) {
    return 'N'
  }
  return rarity
}

export default function PlantCard({ plant = EMPTY_PLANT }) {
  const currentPlant = plant ?? EMPTY_PLANT
  const rarity = getRarityValue(currentPlant.rarity)
  
  const [isPressed, setIsPressed] = useState(false)
  const longPressTimerRef = useRef(null)

  // Set the CSS custom property for rarity-based coloring
  const plantCardStyle = {
    '--plant-rarity-color': `var(--plant-${rarity})`,
  }

  /**
   * Handle touch start - begin tracking for long-press.
   * Long-press threshold: 500ms
   */
  const handleTouchStart = () => {
    longPressTimerRef.current = setTimeout(() => {
      setIsPressed(true)
    }, 500)
  }

  /**
   * Handle touch end - clear timer and remove pressed state.
   */
  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    setIsPressed(false)
  }

  /**
   * Handle touch move - cancel long-press if the touch moved.
   */
  const handleTouchMove = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
      setIsPressed(false)
    }
  }

  return (
    <div
      className={`plant-card${isPressed ? ' is-pressed' : ''}`}
      style={plantCardStyle}
      aria-label="Plant card preview"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      <div className="blob" aria-hidden="true" />
      <div className="bg" aria-hidden="true" />

      <div className="plant-card__content">
        {currentPlant.photoUrl && (
          <img
            className="plant-card__photo"
            src={currentPlant.photoUrl}
            alt={currentPlant.name ?? 'Plant photo'}
          />
        )}
        <div className="plant-card__bottom">
          <div className="plant-card__left">
            <div className="plant-card__name">{currentPlant.name ?? 'Unknown'}</div>
            <div className="plant-card__id">{currentPlant.uniqueId ?? '—'}</div>
          </div>
          <div className="plant-card__rarity">{rarity}</div>
        </div>
      </div>
    </div>
  )
}
