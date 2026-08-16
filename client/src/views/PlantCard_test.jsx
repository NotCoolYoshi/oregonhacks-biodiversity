import PlantCard from '../components/PlantCard'

const DEMO_PLANTS = [
  {
    name: 'Western Redcedar',
    scientificName: 'Thuja plicata',
    uniqueId: 'WRC-0031',
    rarity: 'N',
  },
  {
    name: 'Coastal Manroot',
    scientificName: 'Marah oreganus',
    uniqueId: 'CM-0042',
    rarity: 'R',
  },
  {
    name: 'Rare Fern',
    scientificName: 'Polystichum lemmonii',
    uniqueId: 'RF-0053',
    rarity: 'SR',
  },
  {
    name: 'Super Rare Orchid',
    scientificName: 'Calypso bulbosa',
    uniqueId: 'SRO-0064',
    rarity: 'SSR',
  },
  {
    name: 'Ultra Rare Plant',
    scientificName: 'Exotic speciosa',
    uniqueId: 'URP-0075',
    rarity: 'UR',
  },
]

export default function PlantCardTest() {
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
      {DEMO_PLANTS.map((plant) => (
        <div key={plant.uniqueId}>
          <PlantCard plant={plant} />
          <p style={{ textAlign: 'center', marginTop: '1rem', fontWeight: 'bold' }}>
            {/* Rarity: {plant.rarity} */}
          </p>
        </div>
      ))}
    </div>
  )
}
