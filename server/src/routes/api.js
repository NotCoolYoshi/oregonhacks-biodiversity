import { Router } from 'express'

import { IDENTIFY_RESULT, placeName } from '../mocks.js'
import { identifyPlant, hasApiKey, PlantNetError } from '../services/plantnet.js'
import {
  resolveTaxonId,
  getTaxonStatus,
  getPhenology,
  getNearbySpecies,
  INaturalistError,
} from '../services/inaturalist.js'

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

/** Shared error handler for the three iNaturalist-backed routes below. */
function handleINaturalistError(err, routeLabel, res, next) {
  if (err instanceof INaturalistError) {
    if (err.retryAfter) res.set('Retry-After', err.retryAfter)
    console.warn(`[${routeLabel}] ${err.code}: ${err.message}`)
    return res.status(err.status).json({ error: err.message, code: err.code })
  }
  next(err)
}

/**
 * Resolve the taxon id for a status/phenology lookup.
 *
 * Pl@ntNet returns `inatTaxonId: null` on every real identification (it only
 * gives us a GBIF id — see services/plantnet.js), so the client can't always
 * put a numeric taxon id in the path. When it doesn't have one, it passes the
 * literal segment `unknown` plus `?scientific_name=`, and we resolve the id
 * here via a name search before continuing — one extra hop, not a redesign.
 */
async function resolveTaxonIdParam(req) {
  const raw = req.params.taxonId
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return numeric

  const scientificName = String(req.query.scientific_name ?? '').trim()
  if (!scientificName) {
    throw new INaturalistError(
      `taxonId must be numeric, or pass ?scientific_name= to resolve it (got "${raw}").`,
      { status: 400, code: 'BAD_REQUEST' },
    )
  }
  return resolveTaxonId(scientificName)
}

/**
 * GET /api/species/:taxonId/status?place_id=&scientific_name=
 * Establishment means + conservation status for a taxon in a place.
 * `classification` is what the client uses to decide catch vs threat_report.
 */
router.get('/species/:taxonId/status', async (req, res, next) => {
  const placeId = Number(req.query.place_id) || DEFAULT_PLACE_ID

  try {
    const taxonId = await resolveTaxonIdParam(req)
    const status = await getTaxonStatus(taxonId, placeId)

    res.json({
      ...status,
      placeId,
      placeName: placeName(placeId),
      source: 'iNaturalist',
    })
  } catch (err) {
    handleINaturalistError(err, 'species/status', res, next)
  }
})

/**
 * GET /api/species/:taxonId/phenology?place_id=&scientific_name=
 * Monthly observation histogram -> which months this species is typically seen.
 */
router.get('/species/:taxonId/phenology', async (req, res, next) => {
  const placeId = Number(req.query.place_id) || DEFAULT_PLACE_ID

  try {
    const taxonId = await resolveTaxonIdParam(req)
    const histogram = await getPhenology(taxonId, placeId)

    const counts = Object.values(histogram)
    const peak = Math.max(...counts)
    // A taxon with no observations here has an all-zero histogram; without this
    // guard `count >= 0` marks all twelve months as peak and claims it's in
    // season year-round.
    const peakMonths =
      peak === 0
        ? []
        : Object.entries(histogram)
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
  } catch (err) {
    handleINaturalistError(err, 'species/phenology', res, next)
  }
})

/**
 * GET /api/region/:placeId/nearby?lat=&lng=&radius=&per_page=
 * Species recently observed near a place — the "catchable nearby" list.
 */
router.get('/region/:placeId/nearby', async (req, res, next) => {
  const placeId = Number(req.params.placeId)
  const radiusKm = Number(req.query.radius) || 25

  try {
    const results = await getNearbySpecies(placeId, {
      lat: req.query.lat != null ? Number(req.query.lat) : undefined,
      lng: req.query.lng != null ? Number(req.query.lng) : undefined,
      radius: radiusKm,
      perPage: req.query.per_page,
    })

    res.json({
      placeId,
      placeName: placeName(placeId),
      radiusKm,
      totalResults: results.length,
      results,
      source: 'iNaturalist',
    })
  } catch (err) {
    handleINaturalistError(err, 'region/nearby', res, next)
  }
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