import { useState, useRef } from 'react'
import '../css/PlantCard.css'

const EMPTY_PLANT = {
  name: null,
  uniqueId: null,
  photoUrl: null,
  rarityScore: null,
}

// Cutoffs a continuous 0-1 rarity_score is mapped onto for this card's five
// existing gacha tiers (colors already defined in PlantCard.css). Mirrors
// server/src/services/rarity.js's gachaTierFor() — kept as a small local
// copy rather than a shared import because client/ and server/ are separate
// packages here (same precedent as this file's old VALID_RARITIES, which
// duplicated a list the server also had). If these numbers move, move both.
//
// PROVISIONAL, same as the server-side cutoffs — see
// docs/rarity-scoring-plan-20260817.md §5/§7 for the real distribution they
// were checked against, and why UR is deliberately narrow (score >= 0.9): in
// the app's current live data, a wide-open UR tier is dominated by demo rows
// caught against the wrong place (zero real local observations, but not
// actually rare) rather than genuinely exceptional catches.
const GACHA_TIERS = [
  [0.3, 'N'],
  [0.5, 'R'],
  [0.7, 'SR'],
  [0.9, 'SSR'],
]
const HIGHEST_GACHA_TIER = 'UR'

/**
 * A catch's rarity_score (0-1, or null/undefined for an unscored row —
 * logged before migration 007, not yet backfilled) -> one of this card's
 * five gacha tiers. Defaults to 'N', same fallback the old string-based
 * version used for a missing/invalid value.
 */
function gachaTierFromScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'N'
  for (const [ceiling, tier] of GACHA_TIERS) {
    if (score < ceiling) return tier
  }
  return HIGHEST_GACHA_TIER
}

export default function PlantCard({ plant = EMPTY_PLANT }) {
  const currentPlant = plant ?? EMPTY_PLANT
  const rarity = gachaTierFromScore(currentPlant.rarityScore)
  
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
