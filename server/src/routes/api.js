import { Router } from 'express'

import {
  IDENTIFY_RESULT,
  SPECIES_STATUS,
  UNKNOWN_STATUS,
  PHENOLOGY_HISTOGRAM,
  NEARBY_SPECIES,
  placeName,
} from '../mocks.js'
import { identifyPlant, hasApiKey, PlantNetError } from '../services/plantnet.js'

const router = Router()

const DEFAULT_PLACE_ID = 10 // iNaturalist place_id for Oregon

/**
 * POST /api/identify
 * Body: { imageBase64 | imageUrl, organs?: string[], lat?, lng? }
 * Returns ranked candidate species for the photo.
 *
 * Real Pl@ntNet call when PLANTNET_API_KEY is set; mock data otherwise, so
 * teammates without a key can still build the capture flow. `source` on the
 * response says which one you got.
 */
router.post('/identify', async (req, res, next) => {
  const body = req.body ?? {}

  if (!body.imageBase64 && !body.imageUrl) {
    return res.status(400).json({ error: 'imageBase64 or imageUrl is required' })
  }

  if (!hasApiKey()) {
    console.warn(
      '[identify] PLANTNET_API_KEY is not set — returning MOCK identification data. ' +
        'Add a key from https://my.plantnet.org/ to server/.env for real results.',
    )
    return res.json({ ...IDENTIFY_RESULT, source: 'mock' })
  }

  try {
    res.json(await identifyPlant(body))
  } catch (err) {
    if (err instanceof PlantNetError) {
      if (err.retryAfter) res.set('Retry-After', err.retryAfter)
      console.warn(`[identify] ${err.code}: ${err.message}`)
      return res.status(err.status).json({ error: err.message, code: err.code })
    }
    next(err)
  }
})

/**
 * GET /api/species/:taxonId/status?place_id=
 * Establishment means + conservation status for a taxon in a place.
 * `classification` is what the client uses to decide catch vs threat_report.
 */
router.get('/species/:taxonId/status', (req, res) => {
  // TODO: GET https://api.inaturalist.org/v1/taxa/${taxonId}?place_id=${placeId}
  // and read `establishment_means` / `conservation_status` off the result.
  const taxonId = Number(req.params.taxonId)
  const placeId = Number(req.query.place_id) || DEFAULT_PLACE_ID

  const status = SPECIES_STATUS[taxonId] ?? { ...UNKNOWN_STATUS, taxonId }

  res.json({
    ...status,
    placeId,
    placeName: placeName(placeId),
    source: 'iNaturalist',
  })
})

/**
 * GET /api/species/:taxonId/phenology?place_id=
 * Monthly observation histogram -> which months this species is typically seen.
 */
router.get('/species/:taxonId/phenology', (req, res) => {
  // TODO: GET https://api.inaturalist.org/v1/observations/histogram
  //   ?taxon_id=${taxonId}&place_id=${placeId}&date_field=observed&interval=month_of_year
  // and use `results.month_of_year` as the histogram.
  const taxonId = Number(req.params.taxonId)
  const placeId = Number(req.query.place_id) || DEFAULT_PLACE_ID

  const histogram = PHENOLOGY_HISTOGRAM
  const counts = Object.values(histogram)
  const peak = Math.max(...counts)
  const peakMonths = Object.entries(histogram)
    .filter(([, count]) => count >= peak * 0.5)
    .map(([month]) => Number(month))

  const currentMonth = new Date().getMonth() + 1

  res.json({
    taxonId,
    placeId,
    placeName: placeName(placeId),
    histogram,
    peakMonths,
    currentMonth,
    inSeasonNow: peakMonths.includes(currentMonth),
    totalObservations: counts.reduce((sum, n) => sum + n, 0),
    source: 'iNaturalist',
  })
})

/**
 * GET /api/region/:placeId/nearby?lat=&lng=&radius=&per_page=
 * Species recently observed near a place — the "catchable nearby" list.
 */
router.get('/region/:placeId/nearby', (req, res) => {
  // TODO: GET https://api.inaturalist.org/v1/observations/species_counts
  //   ?place_id=${placeId}&iconic_taxa=Plantae&d1=<30 days ago>
  // (or lat/lng/radius when the user has shared their location).
  const placeId = Number(req.params.placeId)
  const perPage = Number(req.query.per_page) || 30

  const results = NEARBY_SPECIES.slice(0, perPage)

  res.json({
    placeId,
    placeName: placeName(placeId),
    radiusKm: Number(req.query.radius) || 25,
    totalResults: results.length,
    results,
    source: 'iNaturalist',
  })
})

/**
 * POST /api/catches
 * Body: { userId, taxonId, scientificName, commonName, type, location: { lat, lng },
 *         placeId, photoUrl, confidence }
 * Records a capture or a threat report.
 */
router.post('/catches', (req, res) => {
  // TODO: persist to the database (Supabase or Firebase — see docs/ARCHITECTURE.md)
  // and recompute the affected region's score. Validate `type` against the
  // server-side status lookup rather than trusting the client.
  const body = req.body ?? {}

  if (!body.taxonId) {
    return res.status(400).json({ error: 'taxonId is required' })
  }

  const type = body.type === 'threat_report' ? 'threat_report' : 'catch'

  res.status(201).json({
    id: `cat_${Math.random().toString(36).slice(2, 10)}`,
    userId: body.userId ?? 'usr_mock_001',
    type,
    taxonId: body.taxonId,
    scientificName: body.scientificName ?? 'Mahonia aquifolium',
    commonName: body.commonName ?? 'Oregon grape',
    placeId: body.placeId ?? DEFAULT_PLACE_ID,
    location: body.location ?? { lat: 44.0521, lng: -123.0868 },
    photoUrl: body.photoUrl ?? 'https://example.org/mock/catch-photo.jpg',
    confidence: body.confidence ?? 0.8734,
    isFirstCatch: true,
    pointsAwarded: type === 'threat_report' ? 25 : 10,
    createdAt: new Date().toISOString(),
  })
})

/**
 * GET /api/region/:placeId/score
 * Aggregates catches into a regional biodiversity health score (0-100).
 */
router.get('/region/:placeId/score', (req, res) => {
  // TODO: aggregate from the catches table — unique native species vs unique
  // invasive species vs contributor count — instead of returning fixtures.
  const placeId = Number(req.params.placeId)

  res.json({
    placeId,
    placeName: placeName(placeId),
    score: 78,
    grade: 'B+',
    components: {
      nativeDiversity: 84,
      invasivePressure: 61,
      observerActivity: 89,
    },
    totals: {
      catches: 142,
      threatReports: 23,
      uniqueNativeSpecies: 38,
      uniqueInvasiveSpecies: 7,
      contributors: 12,
    },
    topThreats: [
      { taxonId: 54566, commonName: 'Himalayan blackberry', reports: 11 },
      { taxonId: 58732, commonName: 'Scotch broom', reports: 7 },
      { taxonId: 49572, commonName: 'English holly', reports: 5 },
    ],
    trend: { direction: 'up', delta7d: 3 },
    computedAt: new Date().toISOString(),
  })
})

export default router
