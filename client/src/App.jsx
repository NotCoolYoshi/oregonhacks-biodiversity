import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'

import ForestBackdrop from './ForestBackdrop'
import PinBanner from './components/PinBanner'
import { ICON_REFERENCE } from './iconReference'
import HomeView from './views/HomeView'
import PhotoCapture from './views/PhotoCapture'
import CatalogueView from './views/CatalogueView'
import MapView from './views/MapView'
import SocialView from './views/SocialView'
import PlantCardTest from './views/PlantCard_test'
import GalleryTest from './views/Gallery_test'

import './App.css'

const TABS = [
  { to: '/', icon: 'home', label: 'Home' },
  { to: '/capture', icon: 'capture', label: 'Capture' },
  { to: '/catalogue', icon: 'catalogue', label: 'Catalogue' },
  { to: '/map', icon: 'map', label: 'Map' },
  { to: '/social', icon: 'social', label: 'Social' },
]

function Nav() {
  return (
    <nav className="nav" aria-label="Main">
      <ul className="nav-list">
        {TABS.map(({ to, icon, label }) => (
          <li key={to}>
            {/* `end` only on "/" — without it the index route matches every
                path and Home would stay lit on all five tabs. */}
            <NavLink to={to} end={to === '/'} className="nav-tab">
              <span className="nav-icon" aria-hidden="true">
                <img src={ICON_REFERENCE[icon]} alt="" />
              </span>
              <span className="nav-label">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ForestBackdrop />
      <PinBanner />
      <div className="app">
        <header className="header">
          <h1>Memoflora</h1>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<HomeView />} />
            <Route path="/capture" element={<PhotoCapture />} />
            <Route path="/catalogue" element={<CatalogueView />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/social" element={<SocialView />} />
            <Route path="/plant" element={<PlantCardTest />} />
            <Route path="/gallery" element={<GalleryTest />} />
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </main>

        <Nav />
      </div>
    </BrowserRouter>
  )
}
