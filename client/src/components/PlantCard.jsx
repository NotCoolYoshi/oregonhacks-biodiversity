import '../css/PlantCard.css'

const EMPTY_PLANT = {
  name: null,
  uniqueId: null,
  photoUrl: null,
}

export default function PlantCard({ plant = EMPTY_PLANT }) {
  const currentPlant = plant ?? EMPTY_PLANT

  return (
    <div className="plant-card" aria-label="Plant card preview">
      <div className="blob" aria-hidden="true" />
      <div className="bg" aria-hidden="true" />

      <div className="plant-card__content">
        <div className="plant-card__row">
          <span>:</span>
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
