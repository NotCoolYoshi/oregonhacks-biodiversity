import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'

import HomeView from './views/HomeView'
import PhotoCapture from './views/PhotoCapture'
import DexView from './views/DexView'
import MapView from './views/MapView'
import RegionDashboard from './views/RegionDashboard'

import './App.css'

/* Stroke-only icons drawn with `currentColor` so the active/inactive and
   light/dark colour changes are handled entirely by the CSS on the link —
   no second asset and no invert filter for dark mode. */
const ICONS = {
  home: <path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  capture: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h2.5l1.7-2.2h5.6L16.5 6H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.6" />
    </>
  ),
  dex: (
    <>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5z" />
      <path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3" />
    </>
  ),
  map: (
    <>
      <path d="m9 3.5 6 3 5.2-2.6a.6.6 0 0 1 .8.5v13.4l-6 3-6-3-5.2 2.6a.6.6 0 0 1-.8-.5V6.5z" />
      <path d="M9 3.5v14M15 6.5v14" />
    </>
  ),
  region: (
    <>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 20v-5M12.5 20V9M17 20v-8" />
    </>
  ),
}

const TABS = [
  { to: '/', icon: 'home', label: 'Home' },
  { to: '/capture', icon: 'capture', label: 'Capture' },
  { to: '/dex', icon: 'dex', label: 'Dex' },
  { to: '/map', icon: 'map', label: 'Map' },
  { to: '/region', icon: 'region', label: 'Region' },
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
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {ICONS[icon]}
                </svg>
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
      <div className="app">
        <header className="header">
          <h1>OregonHacks Biodiversity</h1>
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

        <Nav />
      </div>
    </BrowserRouter>
  )
}
