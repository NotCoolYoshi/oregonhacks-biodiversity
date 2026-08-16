import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// theme.css first: it declares the custom properties everything else reads.
import './theme.css'
import './index.css'
import ClerkApp from './ClerkApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkApp />
  </StrictMode>,
)
