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
import { getSupabase, isConfigured as hasDatabase } from '../db/supabaseClient.js'

const router = Router()

const DEFAULT_PLACE_ID = 10 // iNaturalist place_id for Oregon

// Threat reports are worth more than catches: spotting an invasive is the
// action we actually want out of this app, and it is the less fun one.
const POINTS = { catch: 10, threat_report: 25 }


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
 * Turn a PostgREST error into something with a status code.
 *
 * Same idea as toPlantNetError / toINaturalistError in the services, but these
 * failures are our own fault rather than an upstream's, so most of them are
 * 500s and the message points at the fix.
 */
function toDatabaseError(error) {
  const err = new Error()
  err.name = 'DatabaseError'
  err.isDatabaseError = true

  switch (error.code) {
    case '42P01': // undefined_table
      err.status = 500
      err.code = 'SCHEMA_MISSING'
      err.message =
        'The catches table does not exist. Run server/src/db/schema.sql in the Supabase SQL editor.'
      break
    case '42703': // undefined_column
      err.status = 500
      err.code = 'SCHEMA_STALE'
      err.message =
        `The catches table is missing a column (${error.message}). Run the files in ` +
        'server/src/db/migrations/ in the Supabase SQL editor.'
      break
    case '42501': // insufficient_privilege
      err.status = 500
      err.code = 'DB_PERMISSION_DENIED'
      err.message =
        'The service role cannot read or write public.catches. Run migration 001 (it ends ' +
        'with the grant) in the Supabase SQL editor.'
      break
    case '23514': // check_violation
      err.status = 400
      err.code = 'DB_CONSTRAINT'
      err.message = `The database rejected this row: ${error.message}`
      break
    default:
      err.status = 502
      err.code = 'DB_UNAVAILABLE'
      err.message = `Database error${error.code ? ` (${error.code})` : ''}: ${error.message}`
  }

  return err
}

/**
 * Guard the two database-backed routes.
 *
 * Mirrors the hasApiKey() check on /identify: a missing config should say so
 * plainly rather than throwing from inside getSupabase().
 */
function requireDatabase(res) {
  if (hasDatabase()) return true

  res.status(503).json({
    error:
      'The database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ' +
      'server/.env, then run src/db/schema.sql in the Supabase SQL editor.',
    code: 'DB_NOT_CONFIGURED',
  })
  return false
}

/**
 * Shared error handler for every route below.
 *
 * Anything already translated — an INaturalistError from the service or a
 * DatabaseError from toDatabaseError — carries its own status and code and is
 * safe to show a user. Everything else is a bug, so it goes to the Express
 * error handler, which logs it and says "Internal server error".
 */
function handleRouteError(err, routeLabel, res, next) {
  if (err instanceof INaturalistError || err.isDatabaseError) {
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
    handleRouteError(err, 'species/status', res, next)
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
    handleRouteError(err, 'species/phenology', res, next)
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
    handleRouteError(err, 'region/nearby', res, next)
  }
})

/**
 * POST /api/catches
 * Body: { userId, taxonId, scientificName, commonName, type, location: { lat, lng },
 *         placeId, photoUrl, confidence }
 * Records a capture or a threat report.
 */
router.post('/catches', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const body = req.body ?? {}
  const userId = String(body.userId ?? '').trim()
  const placeId = Number(body.placeId) || DEFAULT_PLACE_ID

  if (!userId) {
    return res.status(400).json({ error: 'userId is required', code: 'BAD_REQUEST' })
  }
  if (!body.taxonId && !body.scientificName) {
    return res
      .status(400)
      .json({ error: 'taxonId or scientificName is required', code: 'BAD_REQUEST' })
  }

  try {
    // Resolve the taxon the same way the status route does — a Pl@ntNet
    // identification arrives with inatTaxonId: null, so the client may only
    // have a name to give us.
    const taxonId = Number(body.taxonId) || (await resolveTaxonId(body.scientificName))

    // The whole point of this route: `type` comes from iNaturalist's
    // establishment means for this taxon in this place, never from the body.
    // A client that could name its own type could report an invasive as a
    // catch (or farm threat-report points off a native) at will.
    const status = await getTaxonStatus(taxonId, placeId)
    const type = status.classification

    const claimedType = body.type === 'threat_report' ? 'threat_report' : 'catch'
    // Overwrite rather than reject: the client's claim carries no authority, so
    // a wrong one is not an error condition, and rejecting would strand a user
    // whose only mistake was photographing an invasive.
    const typeCorrected = Boolean(body.type) && claimedType !== type
    if (typeCorrected) {
      console.warn(
        `[catches] client claimed ${claimedType} for taxon ${taxonId} ` +
          `(${status.scientificName}); iNaturalist says ${status.establishmentMeans} — ` +
          `recorded as ${type}`,
      )
    }

    const sb = getSupabase()

    // "First catch" is per user per species, and drives the dex's new-entry
    // celebration. Checked before the insert, or it would always be false.
    const { data: existing, error: existingError } = await sb
      .from('catches')
      .select('id')
      .eq('user_id', userId)
      .eq('taxon_id', taxonId)
      .limit(1)

    if (existingError) throw toDatabaseError(existingError)
    const isFirstCatch = (existing?.length ?? 0) === 0

    const location = body.location ?? {}
    const { data: row, error: insertError } = await sb
      .from('catches')
      .insert({
        user_id: userId,
        taxon_id: taxonId,
        // Prefer iNaturalist's names over the client's: they are canonical,
        // and scientific_name is NOT NULL.
        scientific_name: status.scientificName ?? body.scientificName ?? null,
        common_name: status.commonName ?? body.commonName ?? null,
        type,
        place_id: placeId,
        place_name: placeName(placeId),
        lat: Number.isFinite(Number(location.lat)) ? Number(location.lat) : null,
        lng: Number.isFinite(Number(location.lng)) ? Number(location.lng) : null,
        photo_url: body.photoUrl ?? null,
        confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : null,
      })
      .select()
      .single()

    if (insertError) throw toDatabaseError(insertError)

    res.status(201).json({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      taxonId: row.taxon_id,
      scientificName: row.scientific_name,
      commonName: row.common_name,
      placeId: row.place_id,
      placeName: row.place_name,
      location: { lat: row.lat, lng: row.lng },
      photoUrl: row.photo_url,
      confidence: row.confidence == null ? null : Number(row.confidence),
      isFirstCatch,
      pointsAwarded: POINTS[row.type],
      createdAt: row.created_at,

      // Additive, so the existing contract still holds. These let the client
      // explain itself when it guessed wrong ("that's an invasive — logged as
      // a threat report").
      establishmentMeans: status.establishmentMeans,
      typeCorrected,
      claimedType: typeCorrected ? claimedType : undefined,
      source: 'iNaturalist',
    })
  } catch (err) {
    handleRouteError(err, 'catches', res, next)
  }
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