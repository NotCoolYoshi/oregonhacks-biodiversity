import { useMemo } from 'react'

import PlantCard from '../components/PlantCard'
import { useCatches } from '../hooks'
import { useCurrentUserId } from '../session'
import { ICON_REFERENCE } from '../iconReference'
import '../css/Gallery.css'

/** Map a catch row (snake_case from the API) to the shape PlantCard expects. */
function toPlantCardProps(catchRow) {
  return {
    name: catchRow.common_name || catchRow.scientific_name || 'Unknown',
    uniqueId: catchRow.id ?? catchRow.taxon_id ?? '—',
    photoUrl: catchRow.photo_url ?? null,
    rarity: catchRow.rarity ?? 'N',
  }
}

export default function Gallery() {
  // Reactive so a sign-in that resolves after mount swaps the anonymous id's
  // (empty) gallery for the signed-in user's, same as CatalogueView.
  const userId = useCurrentUserId()
  const { catches, loading, error } = useCatches({ userId })

  const plants = useMemo(() => catches.map(toPlantCardProps), [catches])

  return (
    <div className="gallery">
      <div className="gallery-header">
        <h2>Gallery</h2>
        <p className="gallery-subtitle">A collection of plants you've discovered.</p>
        {!loading && !error && plants.length > 0 && (
          <p className="gallery-count">
            {plants.length} {plants.length === 1 ? 'plant' : 'plants'} collected
          </p>
        )}
      </div>

      <div className="gallery-field">
        {loading && <p className="capture-muted">Loading your collection…</p>}
        {!loading && error && (
          <p className="capture-note">Could not load your collection right now.</p>
        )}
        {!loading && !error && plants.length === 0 && (
          <div className="empty-state">
            <img className="empty-icon" src={ICON_REFERENCE.plant} alt="" />
            <p>Nothing collected yet. Photograph a plant from the Capture tab to begin.</p>
          </div>
        )}

        {plants.length > 0 && (
          <div className="gallery-grid">
            {plants.map((plant) => (
              <div className="gallery-slot" key={plant.uniqueId}>
                <PlantCard plant={plant} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
