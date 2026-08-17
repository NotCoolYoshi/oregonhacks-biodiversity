import PlantCard from '../components/PlantCard'
import { useCatches } from '../hooks'

/**
 * Map a catch row (snake_case from the API) to the shape PlantCard expects.
 */
function toPlantCardProps(catchRow) {
  return {
    name: catchRow.common_name || catchRow.scientific_name || 'Unknown',
    uniqueId: catchRow.id ?? catchRow.taxon_id ?? '—',
    photoUrl: catchRow.photo_url ?? null,
    rarityScore: catchRow.rarity_score ?? null,
  }
}

export default function PlantCardTest() {
  const { catches, loading, error } = useCatches()

  // Derive display-ready plant objects from the API data
  const plants = catches.map(toPlantCardProps)

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: '2rem',
        justifyItems: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        padding: '2rem',
        backgroundColor: '#f5f5f0',
      }}
    >
      {loading && (
        <p style={{ gridColumn: '1 / -1', textAlign: 'center' }}>Loading plants…</p>
      )}
      {!loading && error && (
        <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#c0392b' }}>
          Could not load plant data.
        </p>
      )}
      {!loading && !error && plants.length === 0 && (
        <p style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
          No plants catalogued yet.
        </p>
      )}
      {plants.map((plant) => (
        <div key={plant.uniqueId}>
          <PlantCard plant={plant} />
          <p style={{ textAlign: 'center', marginTop: '1rem', fontWeight: 'bold' }}>
            {/* Rarity score: {plant.rarityScore} */}
          </p>
        </div>
      ))}
    </div>
  )
}
