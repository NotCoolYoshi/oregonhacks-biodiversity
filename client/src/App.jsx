import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
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

export default function App() {
  return (
    <BrowserRouter>
      <ForestBackdrop />
      <PinBanner />
      <div className="app">
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
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </main>

        <Nav />
      </div>
    </BrowserRouter>
  )
}
