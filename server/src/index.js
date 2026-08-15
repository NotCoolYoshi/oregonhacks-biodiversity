import 'dotenv/config'

import express from 'express'
import cors from 'cors'

import apiRouter from './routes/api.js'

const app = express()
// 5001, not 5000: macOS AirPlay Receiver holds port 5000 by default.
const PORT = process.env.PORT || 5001

// Vite's dev server. Add deployed origins here (or via CLIENT_ORIGIN) later.
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())

app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: '10mb' })) // photos arrive base64-encoded

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

app.use('/api', apiRouter)

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` })
})

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
  console.log(`[server] CORS origins: ${allowedOrigins.join(', ')}`)
})
