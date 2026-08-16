import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'

import HomeView from './views/HomeView'
import PhotoCapture from './views/PhotoCapture'
import DexView from './views/DexView'
import MapView from './views/MapView'
import RegionDashboard from './views/RegionDashboard'

import './App.css'

function Nav() {
  return (
    <nav className="nav">
      <NavLink to="/">Home</NavLink>
      <NavLink to="/capture">Capture</NavLink>
      <NavLink to="/dex">Dex</NavLink>
      <NavLink to="/map">Map</NavLink>
      <NavLink to="/region">Region</NavLink>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="header">
          <h1>OregonHacks Biodiversity</h1>
          <Nav />
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<HomeView />} />
            <Route path="/capture" element={<PhotoCapture />} />
            <Route path="/dex" element={<DexView />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/region" element={<RegionDashboard />} />
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
