import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { SignedIn, SignedOut, SignIn, SignUp, UserButton } from '@clerk/clerk-react'

import ForestBackdrop from './ForestBackdrop'
import PinBanner from './components/PinBanner'
import { ICON_REFERENCE } from './iconReference'
import { hasClerk } from './clerkConfig'
import HomeView from './views/HomeView'
import PhotoCapture from './views/PhotoCapture'
import CatalogueView from './views/CatalogueView'
import MapView from './views/MapView'
import SocialView from './views/SocialView'
import PlantCardTest from './views/PlantCard_test'
import GalleryTest from './views/Gallery_test'

import './App.css'

/**
 * Sign-in state in the header, prebuilt-only per the auth plan — no custom
 * auth UI. Rendered only when hasClerk: <SignedIn>/<SignedOut>/<UserButton>
 * throw if there is no <ClerkProvider> above them, which ClerkApp.jsx skips
 * mounting when VITE_CLERK_PUBLISHABLE_KEY is unset.
 */
function AuthStatus() {
  if (!hasClerk) return null

  return (
    <div className="auth-status">
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
      <SignedOut>
        <NavLink to="/sign-in" className="auth-sign-in-link">
          Sign in
        </NavLink>
      </SignedOut>
    </div>
  )
}

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

/**
 * Everything that needs to know the current route. Split out from App() so
 * that useLocation() has a Router above it — App() itself renders
 * <BrowserRouter>, which is one level too high to call it.
 */
function AppShell() {
  const location = useLocation()
  // The banner's tips are photo-capture-oriented, not map-relevant, and its
  // fixed positioning is what let it cover the map's zoom control on small
  // viewports (see App.css .pin-banner) — skipping it here removes the
  // overlap at the source rather than fighting it with z-index alone.
  const showPinBanner = location.pathname !== '/map'

  return (
    <>
      <ForestBackdrop />
      <div className="app">
        {/* Rendered inside .app, not as its sibling: .app is `position:
            relative; z-index: 1`, which makes it a stacking context of its
            own. A pin-banner sibling to .app would out-rank that whole
            context — Leaflet's controls and the bottom nav included — no
            matter what z-index they carry internally. As a descendant here,
            .pin-banner's z-index is instead compared against .nav and
            Leaflet's panes/controls within the same context, where it's
            meant to lose. */}
        {showPinBanner && <PinBanner />}
        <header className="header">
          <h1>Memoflora</h1>
          <AuthStatus />
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<HomeView />} />
            <Route path="/capture" element={<PhotoCapture />} />
            <Route path="/catalogue" element={<CatalogueView />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/social" element={<SocialView />} />
            {/* Wildcard paths: Clerk's own routing (email-link callbacks, SSO
                redirects) navigates to sub-paths under these, so the route has
                to match more than the bare path. */}
            {hasClerk && (
              <>
                <Route path="/sign-in/*" element={<SignIn routing="path" path="/sign-in" />} />
                <Route path="/sign-up/*" element={<SignUp routing="path" path="/sign-up" />} />
              </>
            )}
            <Route path="/plant" element={<PlantCardTest />} />
            <Route path="/gallery" element={<GalleryTest />} />
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </main>

        <Nav />
      </div>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}
