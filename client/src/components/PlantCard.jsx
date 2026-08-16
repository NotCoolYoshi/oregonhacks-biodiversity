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

  // Set the CSS custom property for rarity-based coloring
  const plantCardStyle = {
    '--plant-rarity-color': `var(--plant-${rarity})`,
  }

  return (
    <div className="plant-card" style={plantCardStyle} aria-label="Plant card preview">
      <div className="blob" aria-hidden="true" />
      <div className="bg" aria-hidden="true" />

      <div className="plant-card__content">
        <div className="plant-card__row">
          <span></span>
          <strong>{currentPlant.name ?? 'null'}</strong>
        </div>

          

        <div className="plant-card__row plant-card__row--id">
          <span>#</span>
          <strong>{currentPlant.uniqueId ?? 'null'}</strong>
        </div>
      </div>
    </div>
  )
}
