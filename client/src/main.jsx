import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// theme.css first: it declares the custom properties everything else reads.
import './theme.css'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
