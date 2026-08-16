import PlantCard from '../components/PlantCard'

const DEMO_PLANT = {
  name: 'Western Redcedar',
  scientificName: 'Thuja plicata',
  uniqueId: 'WRC-0031',
}

export default function PlantCardTest() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '50vh',
        padding: '2rem',
      }}
    >
      <PlantCard plant={DEMO_PLANT} />
    </div>
  )
}
