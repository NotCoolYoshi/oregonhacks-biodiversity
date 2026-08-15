import { MapContainer, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

// Rough center of Oregon — swap for the user's geolocation later.
const DEFAULT_CENTER = [44.0, -120.5]
const DEFAULT_ZOOM = 7

export default function MapView() {
  // TODO: load catches (catch + threat_report) and plot them as markers,
  // colored by type. Invasive threat reports get a distinct marker layer.
  return (
    <section>
      <h2>Map</h2>
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '70vh', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
      </MapContainer>
    </section>
  )
}
