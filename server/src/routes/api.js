import { Router } from 'express'

import { IDENTIFY_RESULT, placeName } from '../mocks.js'
import { identifyPlant, hasApiKey, PlantNetError } from '../services/plantnet.js'
import {
  resolveTaxonId,
  getTaxonStatus,
  getPhenology,
  getNearbySpecies,
  getNearbyObservations,
  getEstablishmentMeans,
  isNativeMeans,
  resolvePlaceFromCoords,
  getPlaceName,
  INaturalistError,
} from '../services/inaturalist.js'
import { getSupabase, isConfigured as hasDatabase } from '../db/supabaseClient.js'
import { uploadCatchPhoto, PhotoStorageError } from '../services/photoStorage.js'

const router = Router()

/**
 * The place used when a request carries neither coordinates nor an explicit id.
 *
 * This used to be DEFAULT_PLACE_ID and it was applied to every request, which
 * is what made the app answer "is this native to Oregon?" no matter where the
 * photo was taken. It is now only reached by a request that gave us nothing to
 * work with — a capture with geolocation denied, or an old client. Anything
 * carrying lat/lng resolves its own place; see resolvePlaceForRequest().
 */
const FALLBACK_PLACE_ID = 10 // iNaturalist place_id for Oregon

// Threat reports are worth more than catches: spotting an invasive is the
// action we actually want out of this app, and it is the less fun one.
const POINTS = { catch: 10, threat_report: 25 }

// Region score tuning. A region hits 100 on a component when it reaches the
// target; these are demo-scale guesses, not ecology.
const NATIVE_SPECIES_TARGET = 50
const CONTRIBUTOR_TARGET = 15

// Upper bound on rows pulled for one region's score. See the comment in
// GET /region/:placeId/score — this is a guard rail, not pagination.
const SCAN_LIMIT = 10_000

// Long enough for a real name, short enough that it cannot wreck the profile
// header it is rendered into.
const MAX_DISPLAY_NAME = 60

// A hard ceiling a caller can lower but not raise — same shape as
// NEARBY_MARKER_CAP below. "Top 50" is a reasonable board for a hackathon-
// scale user base; if this ever needs real pagination, that is a sign the
// user base outgrew a single unpaginated read anyway.
const LEADERBOARD_LIMIT = 50

// ---------------------------------------------------------------------------
// Badges
//
// Counted against distinct species (taxon_id), not raw catch rows — the same
// unit the catalogue has always used for milestones (see the client's old,
// now-removed MILESTONES mock). Photographing the same plant five times is
// one milestone, not five. Native badges count catches where type = 'catch';
// invasive badges count type = 'threat_report' — see GET
// /users/:userId/achievements for how the two counts are read.
//
// Order matters: badgeState() below assumes each list is sorted ascending by
// threshold, which both of these are.
// ---------------------------------------------------------------------------
const NATIVE_BADGES = [
  { threshold: 1, label: 'First Seed' },
  { threshold: 5, label: 'Tender Sprout' },
  { threshold: 10, label: 'Budding Grace' },
  { threshold: 25, label: "Petal's Promise" },
  { threshold: 50, label: 'In Full Bloom' },
  { threshold: 75, label: 'Verdant Bloom' },
  { threshold: 100, label: 'Keeper of the Garden' },
]

const INVASIVE_BADGES = [
  { threshold: 1, label: 'First Watch' },
  { threshold: 5, label: 'Vigilant Hand' },
  { threshold: 10, label: 'Warden of the Wild' },
  { threshold: 25, label: 'Guardian of the Grove' },
]

/** Attach `unlocked` to each badge in a (sorted) list, given a species count. */
const badgeState = (badges, count) => badges.map((b) => ({ ...b, unlocked: count >= b.threshold }))

const clampPercent = (n) => Math.max(0, Math.min(100, Math.round(n)))

/**
 * A name for a user who has not chosen one — "Explorer 4821".
 *
 * Four digits, so it reads like a handle rather than an id, and collisions are
 * both likely and harmless: this is a label, and user_id is what identifies
 * anyone. Nothing anywhere requires display_name to be unique.
 */
function defaultDisplayName() {
  return `Explorer ${Math.floor(1000 + Math.random() * 9000)}`
}

/** A public.users row as the API speaks it. `created` distinguishes 201 from 200. */
const serializeUser = (row, created) => ({
  userId: row.user_id,
  displayName: row.display_name ?? null,
  createdAt: row.created_at,
  created,
  source: 'supabase',
})

/** Standard US letter scale. The mock's 78 = 'B+' was fiction. */
function gradeFor(score) {
  const scale = [
    [97, 'A+'], [93, 'A'], [90, 'A-'],
    [87, 'B+'], [83, 'B'], [80, 'B-'],
    [77, 'C+'], [73, 'C'], [70, 'C-'],
    [67, 'D+'], [63, 'D'], [60, 'D-'],
  ]
  return scale.find(([min]) => score >= min)?.[1] ?? 'F'
}

// ---------------------------------------------------------------------------
// Places
//
// Which place a request is about decides which species checklist the
// native/invasive verdict is read from, so this is the hinge the whole
// classification turns on. It is derived from the coordinates the capture flow
// already sends, never from a constant.
// ---------------------------------------------------------------------------

/**
 * Name a place id, degrading rather than failing.
 *
 * iNaturalist is the authority, mocks.PLACES is the offline seed, and
 * "Place 40" is the floor. A name is decoration on every route that renders one
 * — none of them should 502 because a label could not be fetched.
 */
async function describePlace(placeId) {
  try {
    return await getPlaceName(placeId)
  } catch {
    return placeName(placeId)
  }
}

/**
 * Decide which place a request is about, in priority order:
 *
 *   1. An explicit placeId. Nothing else can override a caller that knows.
 *   2. Coordinates -> the containing place, via iNaturalist. This is the path
 *      every real capture takes, and it is what makes the verdict local.
 *   3. FALLBACK_PLACE_ID, for a request that supplied neither.
 *
 * Step 2 degrades to step 3 rather than failing: geolocation that cannot be
 * turned into a place is a reason to fall back, not a reason to refuse a catch.
 * `source` reports which step answered so callers can say so.
 *
 * @returns {Promise<{ placeId: number, placeName: string, source: string }>}
 */
async function resolvePlaceForRequest({ lat, lng, placeId }) {
  const explicit = Number(placeId)
  if (Number.isFinite(explicit) && explicit > 0) {
    return { placeId: explicit, placeName: await describePlace(explicit), source: 'explicit' }
  }

  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
  if (hasCoords) {
    try {
      const place = await resolvePlaceFromCoords(lat, lng)
      if (place) {
        return { placeId: place.placeId, placeName: place.placeName, source: 'coordinates' }
      }
      console.warn(`[places] no standard iNaturalist place contains (${lat}, ${lng})`)
    } catch (err) {
      console.warn(`[places] could not resolve (${lat}, ${lng}): ${err.message}`)
    }
  }

  return {
    placeId: FALLBACK_PLACE_ID,
    placeName: await describePlace(FALLBACK_PLACE_ID),
    source: 'fallback',
  }
}

/**
 * GET /api/places/resolve?lat=&lng=
 * Coordinates -> the place whose species list applies there.
 *
 * The client needs this on its own for the map, which has to know which
 * region's score to show before it has anything to identify.
 */
router.get('/places/resolve', async (req, res, next) => {
  const { lat, lng } = req.query

  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng are required', code: 'BAD_REQUEST' })
  }

  try {
    const place = await resolvePlaceFromCoords(lat, lng)

    if (!place) {
      return res.status(404).json({
        error: `iNaturalist has no place covering (${lat}, ${lng}).`,
        code: 'PLACE_NOT_FOUND',
      })
    }

    res.json({ ...place, source: 'iNaturalist' })
  } catch (err) {
    handleRouteError(err, 'places/resolve', res, next)
  }
})

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

// Which file to run when a table is missing or ungranted. The whole value of
// these messages is that they name the exact thing to paste into the SQL
// editor, so a new table has to be listed here or its errors send people to
// the wrong file.
const SCHEMA_SOURCE = {
  catches: { create: 'server/src/db/schema.sql', grant: 'migration 001' },
  users: { create: 'server/src/db/migrations/003_add_users_table.sql', grant: 'migration 003' },
}

/**
 * Turn a PostgREST error into something with a status code.
 *
 * Same idea as toPlantNetError / toINaturalistError in the services, but these
 * failures are our own fault rather than an upstream's, so most of them are
 * 500s and the message points at the fix.
 *
 * `table` only steers that message. Pass the one the failed query touched.
 */
function toDatabaseError(error, table = 'catches') {
  const err = new Error()
  err.name = 'DatabaseError'
  err.isDatabaseError = true

  const source = SCHEMA_SOURCE[table] ?? SCHEMA_SOURCE.catches

  switch (error.code) {
    case '42P01': // undefined_table
      err.status = 500
      err.code = 'SCHEMA_MISSING'
      err.message =
        `The ${table} table does not exist. Run ${source.create} in the Supabase SQL editor.`
      break
    case '42703': // undefined_column
      err.status = 500
      err.code = 'SCHEMA_STALE'
      err.message =
        `The ${table} table is missing a column (${error.message}). Run the files in ` +
        'server/src/db/migrations/ in the Supabase SQL editor.'
      break
    case '42501': // insufficient_privilege
      err.status = 500
      err.code = 'DB_PERMISSION_DENIED'
      err.message =
        `The service role cannot read or write public.${table}. Run ${source.grant} (it ends ` +
        'with the grant) in the Supabase SQL editor.'
      break
    case '23514': // check_violation
      err.status = 400
      err.code = 'DB_CONSTRAINT'
      err.message = `The database rejected this row: ${error.message}`
      break
    case '23505': // unique_violation
      // POST /api/catches checks for a duplicate before inserting, so reaching
      // this means two requests raced past that check. The unique index added
      // in migration 002 is what actually makes the rule hold.
      //
      // POST /api/users can also race, but it resolves its own 23505 by
      // re-reading the winner's row and never gets here.
      err.status = 409
      err.code = 'DUPLICATE_CATCH'
      err.message = 'You have already logged that species in this place.'
      break
    default:
      err.status = 502
      err.code = 'DB_UNAVAILABLE'
      err.message = `Database error${error.code ? ` (${error.code})` : ''}: ${error.message}`
  }

  return err
}

/**
 * Guard the database-backed routes.
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
  if (err instanceof INaturalistError || err.isDatabaseError || err.isPhotoStorageError) {
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
 * GET /api/species/:taxonId/status?lat=&lng=&place_id=&scientific_name=
 * Establishment means + conservation status for a taxon in a place.
 * `classification` is what the client uses to decide catch vs threat_report.
 *
 * Pass lat/lng — the place is derived from them. `place_id` still overrides,
 * for a caller that already knows which region it means.
 */
router.get('/species/:taxonId/status', async (req, res, next) => {
  try {
    const place = await resolvePlaceForRequest({
      lat: req.query.lat,
      lng: req.query.lng,
      placeId: req.query.place_id,
    })
    const taxonId = await resolveTaxonIdParam(req)
    const status = await getTaxonStatus(taxonId, place.placeId)

    res.json({
      ...status,
      placeId: place.placeId,
      placeName: place.placeName,
      // Which of the three rules named this place. 'fallback' means we had
      // nothing to go on and the verdict may be about the wrong region — the
      // client says so rather than presenting it as local.
      placeSource: place.source,
      source: 'iNaturalist',
    })
  } catch (err) {
    handleRouteError(err, 'species/status', res, next)
  }
})

/**
 * GET /api/species/:taxonId/phenology?lat=&lng=&place_id=&scientific_name=
 * Monthly observation histogram -> which months this species is typically seen.
 */
router.get('/species/:taxonId/phenology', async (req, res, next) => {
  try {
    const place = await resolvePlaceForRequest({
      lat: req.query.lat,
      lng: req.query.lng,
      placeId: req.query.place_id,
    })
    const placeId = place.placeId
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
      placeName: place.placeName,
      placeSource: place.source,
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
      placeName: await describePlace(placeId),
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
 * The most markers this endpoint will ever hand back for one viewport.
 *
 * A hard ceiling rather than a default the client can raise. It is doing two
 * jobs at once — keeping a zoomed-out view from asking iNaturalist for a
 * continent's worth of pins, and keeping the map from rendering a thousand
 * Leaflet markers — and a limit a caller can talk its way past does neither.
 */
const NEARBY_MARKER_CAP = 30

/**
 * The taxon ids this user has already caught.
 *
 * Degrades to "none" rather than failing. This powers the *unknown* in "nearby
 * unknown plants", so losing it shows the user a few species they have already
 * found — a worse layer, not a broken one, and much better than no layer at
 * all. `hasDatabase()` being false is the ordinary case for a teammate running
 * without Supabase keys, so it is not even a warning.
 */
async function caughtTaxonIds(userId) {
  if (!userId || !hasDatabase()) return new Set()

  try {
    const { data, error } = await getSupabase()
      .from('catches')
      .select('taxon_id')
      .eq('user_id', userId)
      .not('taxon_id', 'is', null)
      .limit(SCAN_LIMIT)

    if (error) throw toDatabaseError(error)
    return new Set(data.map((row) => Number(row.taxon_id)).filter(Number.isFinite))
  } catch (err) {
    console.warn(`[observations/nearby] could not read catches for ${userId}: ${err.message}`)
    return new Set()
  }
}

/**
 * GET /api/observations/nearby?lat=&lng=&radius=&userId=&limit=
 * Plants observed near a coordinate that this user has *not* caught yet.
 *
 * The map's additive layer: what is out there to go find. Never load-bearing —
 * the client drops the layer on any failure rather than surfacing an error, so
 * this route's job when things go wrong is to say so honestly and let the
 * client decide, not to paper over it with an empty 200.
 *
 * Cost control lives in three places and all three matter: the ~1km grid cache
 * in getNearbyObservations() (24h, so a pan over covered ground is free), the
 * client's settle-debounce (one request per pause, not per frame), and
 * NEARBY_MARKER_CAP below.
 */
router.get('/observations/nearby', async (req, res, next) => {
  const { lat, lng } = req.query

  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng are required', code: 'BAD_REQUEST' })
  }

  const userId = String(req.query.userId ?? '').trim()
  const requestedLimit = Number(req.query.limit)
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : NEARBY_MARKER_CAP,
    NEARBY_MARKER_CAP,
  )

  try {
    // Both at once: the catch list is a database read and the observations are
    // an upstream call (usually a cache hit), and neither needs the other.
    const [observations, caught] = await Promise.all([
      getNearbyObservations(lat, lng, { radiusKm: req.query.radius }),
      caughtTaxonIds(userId),
    ])

    const unknown = observations.filter((observation) => !caught.has(observation.taxonId))

    res.json({
      // Echoed back so the client can drop a response that landed after the
      // user has already panned somewhere else.
      lat: Number(lat),
      lng: Number(lng),
      // How many of the nearby species this user has already found. The
      // difference between "nothing grows here" and "you've caught it all",
      // which the empty layer alone cannot say.
      excludedCaught: observations.length - unknown.length,
      totalResults: unknown.length,
      capped: unknown.length > limit,
      results: unknown.slice(0, limit),
      source: 'iNaturalist',
    })
  } catch (err) {
    handleRouteError(err, 'observations/nearby', res, next)
  }
})

/**
 * POST /api/catches
 * Body: { userId, taxonId, scientificName, commonName, family, type, location: { lat, lng },
 *         placeId, photoUrl, confidence }
 * Records a capture or a threat report.
 *
 * `location` decides the place, and through it the native/invasive verdict —
 * see resolvePlaceForRequest(). `placeId` is accepted but no longer expected
 * from the capture flow.
 *
 * `family` is Pl@ntNet's, passed straight through from the client (see
 * plantnet.js's mapResult) — unlike scientificName/commonName there is no
 * iNaturalist family lookup for this route to prefer instead. Trusted at the
 * same level lat/lng already are: not a classification, so nothing here turns
 * on it being right.
 */
router.post('/catches', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const body = req.body ?? {}
  const userId = String(body.userId ?? '').trim()
  const location = body.location ?? {}

  if (!userId) {
    return res.status(400).json({ error: 'userId is required', code: 'BAD_REQUEST' })
  }
  if (!body.taxonId && !body.scientificName) {
    return res
      .status(400)
      .json({ error: 'taxonId or scientificName is required', code: 'BAD_REQUEST' })
  }

  try {
    // Where the photo was taken, which decides which checklist the verdict
    // below is read from. Resolved server-side from the submitted coordinates
    // for the same reason `type` is: a client that names its own place could
    // name one where its invasive is native.
    const place = await resolvePlaceForRequest({
      lat: location.lat,
      lng: location.lng,
      placeId: body.placeId,
    })
    const placeId = place.placeId

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

    // One query answers two questions, because both are about this user's
    // history with this taxon:
    //
    //   isFirstCatch — has this user logged this species ANYWHERE before?
    //                  Drives the catalogue's new-entry celebration, so it has to be
    //                  read before the insert or it is always false.
    //   duplicate    — has this user already logged it in THIS place? That is
    //                  the same row twice, and it is how you farm points by
    //                  photographing one blackberry bush repeatedly.
    //
    // The two differ deliberately: the same species in a new region is a real
    // observation worth recording, just not a new catalogue entry.
    const { data: existing, error: existingError } = await sb
      .from('catches')
      .select('id, place_id')
      .eq('user_id', userId)
      .eq('taxon_id', taxonId)

    if (existingError) throw toDatabaseError(existingError)

    const priorHere = existing?.find((row) => Number(row.place_id) === placeId)
    if (priorHere) {
      return res.status(409).json({
        error:
          `You have already logged ${status.scientificName} in ` +
          `${place.placeName}. Catch it somewhere else for another entry.`,
        code: 'DUPLICATE_CATCH',
        existingCatchId: priorHere.id,
      })
    }

    const isFirstCatch = (existing?.length ?? 0) === 0

    // Store the photo before the row, so a row never points at an object that
    // failed to upload. The other order is worse: a broken image in the
    // catalogue is invisible until someone opens the card, while a failed
    // upload here is reported immediately and costs the user one retry.
    //
    // Deliberately after the duplicate check — no point spending an upload on
    // a catch that is about to be refused.
    let photoUrl = body.photoUrl ?? null
    if (body.photoBase64) {
      photoUrl = await uploadCatchPhoto(body.photoBase64, userId)
    }

    const { data: row, error: insertError } = await sb
      .from('catches')
      .insert({
        user_id: userId,
        taxon_id: taxonId,
        // Prefer iNaturalist's names over the client's: they are canonical,
        // and scientific_name is NOT NULL.
        scientific_name: status.scientificName ?? body.scientificName ?? null,
        common_name: status.commonName ?? body.commonName ?? null,
        family: String(body.family ?? '').trim() || null,
        type,
        place_id: placeId,
        place_name: place.placeName,
        lat: Number.isFinite(Number(location.lat)) ? Number(location.lat) : null,
        lng: Number.isFinite(Number(location.lng)) ? Number(location.lng) : null,
        photo_url: photoUrl,
        confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : null,
      })
      .select()
      .single()

    if (insertError) throw toDatabaseError(insertError)

    // This catch's position within (user_id, family) — "your 3rd Rosaceae
    // catch." A read after the insert, not a stored counter: the row just
    // written is already in the table, so counting every row that matches is
    // both the count and the correct sequence number for it in one query,
    // with no separate increment step that could drift from reality.
    //
    // Only meaningful when this catch carries a family. Rows with no family —
    // either this client sent none, or the catch predates migration 004 —
    // don't match `.eq('family', ...)` against anything and so never enter
    // anyone's count; see that migration's comment for why that's correct.
    let familySequence = null
    if (row.family) {
      const { data: familyRows, error: familyError } = await sb
        .from('catches')
        .select('id')
        .eq('user_id', userId)
        .eq('family', row.family)

      if (familyError) throw toDatabaseError(familyError)
      familySequence = familyRows.length
    }

    res.status(201).json({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      taxonId: row.taxon_id,
      scientificName: row.scientific_name,
      commonName: row.common_name,
      family: row.family,
      familySequence,
      placeId: row.place_id,
      placeName: row.place_name,
      // Which rule named the place. 'fallback' is the one worth showing a user:
      // it means the verdict above is about FALLBACK_PLACE_ID, not about where
      // they are standing.
      placeSource: place.source,
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
 * GET /api/catches?userId=&placeId=
 * Lists recorded catches and threat reports, newest first.
 *
 * Both filters are optional and AND together when both are given:
 *   (none)                    every row, capped at SCAN_LIMIT
 *   ?userId=usr_1             one user's history, anywhere  -> the catalogue
 *   ?placeId=10               everything logged in a place  -> the map
 *   ?userId=usr_1&placeId=10  one user's history in a place
 *
 * Rows come back in the database's own snake_case rather than the camelCase
 * POST /catches responds with. This is a projection of table rows, and the
 * client renders them as-is; translating would buy nothing but a mapping layer
 * to keep in sync.
 *
 * Rows with a null lat/lng are included. A catch recorded without geolocation
 * is still a real observation and still belongs in the catalogue — deciding what is
 * mappable is the map's job, not this endpoint's.
 *
 * Index note: the filters and the sort are shaped to match the indexes in
 * schema.sql — catches_user_created_idx (user_id, created_at desc) covers the
 * userId form including the ORDER BY, and catches_place_id_idx covers placeId.
 */
router.get('/catches', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const userId = String(req.query.userId ?? '').trim()

  // Distinguish "not supplied" from "supplied but junk". `?placeId=abc` is a
  // client bug worth a 400; silently serving every place would hide it.
  const placeIdRaw = req.query.placeId
  const hasPlaceId = placeIdRaw != null && String(placeIdRaw).trim() !== ''
  const placeId = Number(placeIdRaw)

  if (hasPlaceId && (!Number.isFinite(placeId) || placeId <= 0)) {
    return res.status(400).json({
      error: `placeId must be a positive number (got "${placeIdRaw}").`,
      code: 'BAD_REQUEST',
    })
  }

  try {
    const sb = getSupabase()

    let query = sb
      .from('catches')
      // photo_url is included now that catches actually carry one. It was
      // withheld while it was always null, and it is safe to serve: the bucket
      // is public-read, so the URL grants nothing the object does not already.
      // user_id stays out — that is the one column here that identifies a
      // person, and no caller needs it back.
      .select(
        'id, taxon_id, scientific_name, common_name, type, lat, lng, ' +
          'place_id, place_name, photo_url, created_at',
      )

    if (userId) query = query.eq('user_id', userId)
    if (hasPlaceId) query = query.eq('place_id', placeId)

    // Same guard rail as the score route: a cap, not pagination. If a single
    // place ever exceeds it this needs a real cursor.
    const { data: rows, error } = await query
      .order('created_at', { ascending: false })
      .limit(SCAN_LIMIT)

    if (error) throw toDatabaseError(error)

    res.json({
      userId: userId || null,
      placeId: hasPlaceId ? placeId : null,
      placeName: hasPlaceId ? await describePlace(placeId) : null,
      totalResults: rows.length,
      catches: rows,
      source: 'supabase',
    })
  } catch (err) {
    handleRouteError(err, 'catches/list', res, next)
  }
})

/**
 * GET /api/supabase/all
 * Fetches all data stored in Supabase tables (`catches` and `users`) along with counts and metadata.
 */
router.get('/supabase/all', async (req, res, next) => {
  if (!requireDatabase(res)) return

  try {
    const sb = getSupabase()

    const [{ data: catches, error: catchesErr }, { data: users, error: usersErr }] =
      await Promise.all([
        sb.from('catches')
          .select(
            'id, user_id, taxon_id, scientific_name, common_name, family, type, lat, lng, place_id, place_name, photo_url, confidence, created_at',
          )
          .order('created_at', { ascending: false })
          .limit(SCAN_LIMIT),
        sb.from('users')
          .select('user_id, display_name, created_at')
          .order('created_at', { ascending: false })
          .limit(SCAN_LIMIT),
      ])

    if (catchesErr) throw toDatabaseError(catchesErr, 'catches')
    if (usersErr) throw toDatabaseError(usersErr, 'users')

    res.json({
      catches: catches ?? [],
      users: users ?? [],
      counts: {
        catches: catches?.length ?? 0,
        users: users?.length ?? 0,
      },
      source: 'supabase',
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    handleRouteError(err, 'supabase/all', res, next)
  }
})


/**
 * POST /api/users
 * Body: { userId, displayName? }
 * Creates the user's row, or renames an existing one. Idempotent.
 *
 * There are no accounts: `userId` is the string the browser generated and kept
 * in localStorage (see client/src/session.js), and this route takes it on
 * trust exactly as POST /catches does. All this table adds is a name to put
 * next to it.
 *
 * Two callers, one route:
 *   { userId }                  first load — establish a row, keep any name it
 *                               already has, generate one if it has none.
 *   { userId, displayName }     the rename action — overwrite it.
 *
 * A blank or whitespace-only displayName counts as "not supplied" rather than
 * an instruction to erase the name; a user who clears the rename field and
 * submits gets to keep what they had.
 */
router.post('/users', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const body = req.body ?? {}
  const userId = String(body.userId ?? '').trim()

  if (!userId) {
    return res.status(400).json({ error: 'userId is required', code: 'BAD_REQUEST' })
  }

  const requestedName = String(body.displayName ?? '').trim()
  const hasDisplayName = requestedName !== ''

  if (requestedName.length > MAX_DISPLAY_NAME) {
    return res.status(400).json({
      error: `displayName must be ${MAX_DISPLAY_NAME} characters or fewer.`,
      code: 'BAD_REQUEST',
    })
  }

  try {
    const sb = getSupabase()

    const { data: found, error: readError } = await sb
      .from('users')
      .select('user_id, display_name, created_at')
      .eq('user_id', userId)

    if (readError) throw toDatabaseError(readError, 'users')

    const existing = found?.[0] ?? null

    // Already here, and the caller has nothing new to say. Hand back what is
    // stored rather than writing an identical row — this is the first-load
    // path, and it runs on every reload.
    if (existing && !hasDisplayName) {
      return res.json(serializeUser(existing, false))
    }

    if (existing) {
      const { data: updated, error: updateError } = await sb
        .from('users')
        .update({ display_name: requestedName })
        .eq('user_id', userId)
        .select()
        .single()

      if (updateError) throw toDatabaseError(updateError, 'users')
      return res.json(serializeUser(updated, false))
    }

    const { data: inserted, error: insertError } = await sb
      .from('users')
      .insert({
        user_id: userId,
        display_name: hasDisplayName ? requestedName : defaultDisplayName(),
      })
      .select()
      .single()

    if (insertError) {
      // Two first-loads raced past the select above and both tried to insert.
      // The primary key settled it; the loser re-reads rather than failing,
      // because "the row exists" is the outcome it wanted anyway.
      if (insertError.code === '23505') {
        const { data: raced, error: rereadError } = await sb
          .from('users')
          .select('user_id, display_name, created_at')
          .eq('user_id', userId)

        if (rereadError) throw toDatabaseError(rereadError, 'users')
        if (raced?.[0]) return res.json(serializeUser(raced[0], false))
      }
      throw toDatabaseError(insertError, 'users')
    }

    res.status(201).json(serializeUser(inserted, true))
  } catch (err) {
    handleRouteError(err, 'users/upsert', res, next)
  }
})

/**
 * GET /api/users/:userId
 * Returns { userId, displayName, totalPoints, catchCount, uniqueSpeciesCount }.
 *
 * Never 404s. A brand new session has a userId before it has a row in `users`
 * — session.js mints the id locally and only then calls POST /users — so a
 * missing row is the normal opening state, not an error. It reports a null
 * displayName and zeros, which is the truth about that user.
 *
 * There is no foreign key between catches.user_id and users.user_id (see
 * migration 003), so the two halves are read independently and neither
 * requires the other to exist. Catches recorded before this table existed
 * still count towards the totals.
 *
 * Counting, deliberately:
 *   catchCount         every row this user has recorded, threat reports
 *                      included — the same sense of "catches" that
 *                      GET /api/catches uses.
 *   uniqueSpeciesCount distinct taxa, so the same species logged in two places
 *                      is one entry in the catalogue. This is what the profile shows
 *                      as "Owned".
 *   totalPoints        POINTS applied per row, from the same table the award
 *                      on POST /catches reads.
 */
router.get('/users/:userId', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const userId = String(req.params.userId ?? '').trim()
  if (!userId) {
    return res.status(400).json({ error: 'userId is required', code: 'BAD_REQUEST' })
  }

  try {
    const sb = getSupabase()

    const [
      { data: found, error: userError },
      { data: rows, error: catchError },
    ] = await Promise.all([
      sb.from('users').select('user_id, display_name, created_at').eq('user_id', userId),
      // Same guard rail as the score route: a cap, not pagination.
      sb.from('catches').select('taxon_id, type').eq('user_id', userId).limit(SCAN_LIMIT),
    ])

    if (userError) throw toDatabaseError(userError, 'users')
    if (catchError) throw toDatabaseError(catchError)

    const catches = rows ?? []

    res.json({
      userId,
      displayName: found?.[0]?.display_name ?? null,
      totalPoints: catches.reduce((sum, row) => sum + (POINTS[row.type] ?? 0), 0),
      catchCount: catches.length,
      uniqueSpeciesCount: new Set(catches.map((row) => row.taxon_id)).size,
      source: 'supabase',
    })
  } catch (err) {
    handleRouteError(err, 'users/get', res, next)
  }
})

/**
 * GET /api/users/:userId/achievements
 * Native and invasive badge state for a user.
 *
 * Decision: on-the-fly, not persisted. This route re-derives everything from
 * `catches` on every call — the same pattern GET /api/users/:userId already
 * uses for totalPoints — rather than reading or writing a badge/unlock table.
 * Reasoning, so this doesn't need re-litigating the next time someone is
 * tempted to add one:
 *
 *   - Both counts (distinct native species, distinct invasive species) are
 *     monotonic. There is no "a badge was unlocked, then un-unlocked" case to
 *     store a transition for — whether badge N is unlocked is fully
 *     determined by comparing a count already sitting in `catches` against a
 *     constant threshold, every time.
 *   - Nothing downstream needs a point-in-time record. No toast fires the
 *     instant a badge unlocks, no feed lists past unlocks, nothing here can
 *     expire or be revoked. Those are the concrete things that would need an
 *     "unlocked at" timestamp — and the moment one of them becomes real, that
 *     is the signal to add a `user_achievements` table, not before.
 *   - A client that wants to detect a *new* unlock (to show a toast, say) can
 *     already do it without server help: diff this response's `unlocked`
 *     flags against the previous response it fetched. That covers the one
 *     case above that sounds like it needs persistence and doesn't.
 *
 * Same duplicate-species handling as GET /api/users/:userId: a species caught
 * in two places is one entry toward the count, not two.
 */
router.get('/users/:userId/achievements', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const userId = String(req.params.userId ?? '').trim()
  if (!userId) {
    return res.status(400).json({ error: 'userId is required', code: 'BAD_REQUEST' })
  }

  try {
    const sb = getSupabase()

    // Same guard rail as GET /api/users/:userId and the score route: a cap,
    // not pagination.
    const { data: rows, error } = await sb
      .from('catches')
      .select('taxon_id, type')
      .eq('user_id', userId)
      .limit(SCAN_LIMIT)

    if (error) throw toDatabaseError(error)

    const catches = rows ?? []
    const nativeSpeciesCount = new Set(
      catches.filter((row) => row.type === 'catch').map((row) => row.taxon_id),
    ).size
    const invasiveSpeciesCount = new Set(
      catches.filter((row) => row.type === 'threat_report').map((row) => row.taxon_id),
    ).size

    res.json({
      userId,
      nativeSpeciesCount,
      invasiveSpeciesCount,
      nativeBadges: badgeState(NATIVE_BADGES, nativeSpeciesCount),
      invasiveBadges: badgeState(INVASIVE_BADGES, invasiveSpeciesCount),
      source: 'supabase',
    })
  } catch (err) {
    handleRouteError(err, 'users/achievements', res, next)
  }
})

/**
 * A name for a leaderboard row whose user has no display_name.
 *
 * Not `defaultDisplayName()` — that mints a fresh random name and would
 * commit nothing to storage, so the same user could show one name here and
 * a different one (or none) the next time GET /api/users/:userId is called.
 * Not "Guest" either, which is what the client renders for a null
 * displayName on its own profile: that reads fine for "you", but a
 * leaderboard lists many strangers at once, and every unnamed row saying
 * "Guest" would make them indistinguishable. A truncated id is at least a
 * stable, distinct handle.
 */
const anonymizedLeaderboardName = (userId) =>
  userId.length > 12 ? `${userId.slice(0, 12)}…` : userId

/**
 * GET /api/leaderboard?place_id=&limit=
 * Ranks users by total points.
 *
 * Same aggregate-everything-in-JS shape as GET /region/:placeId/score: no
 * COUNT/GROUP BY/JOIN in PostgREST, so this reads `catches` and `users`
 * (guard-railed by SCAN_LIMIT, not paginated) and folds both in JS, the same
 * way GET /api/users/:userId merges its two independent queries — there is
 * still no FK between them (migration 003), so a row in one table with no
 * match in the other is expected, not an error.
 *
 * Score is SUM(points), not a catch count. POINTS already exists (see
 * above) and is what totalPoints on GET /api/users/:userId reads — a
 * threat_report outscoring a catch there is deliberate (spotting an
 * invasive is the harder, more valuable action), and a leaderboard that
 * ranked by raw catch count would rank around that incentive instead of
 * with it.
 *
 * `place_id` is optional and scopes the ranking (and both species counts) to
 * one region — cheap, since catches_place_id_idx already serves it. Omitted,
 * this is a global leaderboard. Either way `users` is read unfiltered: a
 * display name and an account's created_at are global facts about a person,
 * not regional ones.
 *
 * Ties: total points descending, then users.created_at ascending (earlier
 * account wins), then userId ascending as a final, fully deterministic
 * fallback. A user with points but no `users` row has no created_at to break
 * a tie with, so they sort after every tied user who has one.
 */
router.get('/leaderboard', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const placeIdRaw = req.query.place_id
  const hasPlaceId = placeIdRaw != null && String(placeIdRaw).trim() !== ''
  const placeId = Number(placeIdRaw)

  if (hasPlaceId && (!Number.isFinite(placeId) || placeId <= 0)) {
    return res.status(400).json({
      error: `place_id must be a positive number (got "${placeIdRaw}").`,
      code: 'BAD_REQUEST',
    })
  }

  const requestedLimit = Number(req.query.limit)
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : LEADERBOARD_LIMIT,
    LEADERBOARD_LIMIT,
  )

  try {
    const sb = getSupabase()

    let catchesQuery = sb.from('catches').select('user_id, taxon_id, type').limit(SCAN_LIMIT)
    if (hasPlaceId) catchesQuery = catchesQuery.eq('place_id', placeId)

    const [{ data: rows, error: catchError }, { data: userRows, error: userError }] =
      await Promise.all([
        catchesQuery,
        sb.from('users').select('user_id, display_name, created_at').limit(SCAN_LIMIT),
      ])

    if (catchError) throw toDatabaseError(catchError)
    if (userError) throw toDatabaseError(userError, 'users')

    const usersById = new Map((userRows ?? []).map((u) => [u.user_id, u]))

    // One pass, one Map keyed by user_id — same shape as the score route's
    // threatsByTaxon. Species are counted the same way GET
    // /users/:userId/achievements counts them: distinct taxon_id per type, so
    // the same species logged in two places is one entry, not two.
    const byUser = new Map()
    for (const row of rows ?? []) {
      let entry = byUser.get(row.user_id)
      if (!entry) {
        entry = { totalPoints: 0, nativeTaxa: new Set(), invasiveTaxa: new Set() }
        byUser.set(row.user_id, entry)
      }
      entry.totalPoints += POINTS[row.type] ?? 0
      if (row.type === 'catch') entry.nativeTaxa.add(row.taxon_id)
      else if (row.type === 'threat_report') entry.invasiveTaxa.add(row.taxon_id)
    }

    const standings = [...byUser.entries()].map(([userId, entry]) => {
      const user = usersById.get(userId)
      const nativeSpeciesCount = entry.nativeTaxa.size
      const invasiveSpeciesCount = entry.invasiveTaxa.size

      return {
        userId,
        displayName: user?.display_name ?? anonymizedLeaderboardName(userId),
        totalPoints: entry.totalPoints,
        nativeSpeciesCount,
        invasiveSpeciesCount,
        // Native + invasive combined, matching the field name (and meaning)
        // GET /api/users/:userId already uses — a drop-in for any caller that
        // only wants one species number.
        uniqueSpeciesCount: nativeSpeciesCount + invasiveSpeciesCount,
        // Tie-break input only, stripped before the response goes out — see
        // the sort below.
        _createdAt: user?.created_at ?? null,
      }
    })

    standings.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
      const aTime = a._createdAt ? new Date(a._createdAt).getTime() : Infinity
      const bTime = b._createdAt ? new Date(b._createdAt).getTime() : Infinity
      if (aTime !== bTime) return aTime - bTime
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
    })

    res.json({
      placeId: hasPlaceId ? placeId : null,
      placeName: hasPlaceId ? await describePlace(placeId) : null,
      // Every user with at least one point, before the limit below cuts the
      // board down — same distinction GET /observations/nearby draws between
      // totalResults and what capped/results actually hand back.
      totalResults: standings.length,
      capped: standings.length > limit,
      standings: standings.slice(0, limit).map(({ _createdAt, ...entry }) => entry),
      source: 'supabase',
    })
  } catch (err) {
    handleRouteError(err, 'leaderboard', res, next)
  }
})

/**
 * GET /api/region/:placeId/score
 * Aggregates catches into a regional biodiversity health score (0-100).
 */
router.get('/region/:placeId/score', async (req, res, next) => {
  if (!requireDatabase(res)) return

  const placeId = Number(req.params.placeId)
  if (!Number.isFinite(placeId) || placeId <= 0) {
    return res
      .status(400)
      .json({ error: `placeId must be a positive number (got "${req.params.placeId}").`,
        code: 'BAD_REQUEST' })
  }

  try {
    const sb = getSupabase()

    // Aggregated in JS rather than SQL. PostgREST has no COUNT(DISTINCT) or
    // GROUP BY, and the alternative — a Postgres view or an RPC — is DDL that
    // has to be applied by hand in the SQL editor, which is a worse trade at
    // this size. SCAN_LIMIT is a guard rail, not a page: if a region ever
    // exceeds it, this needs to become a view.
    const { data: rows, error } = await sb
      .from('catches')
      .select('taxon_id, type, user_id, common_name, scientific_name, created_at')
      .eq('place_id', placeId)
      .limit(SCAN_LIMIT)

    if (error) throw toDatabaseError(error)

    const catches = rows.filter((row) => row.type === 'catch')
    const threats = rows.filter((row) => row.type === 'threat_report')

    // `type` alone cannot answer "how many native species are here".
    // classify() files a taxon as 'catch' both when iNaturalist confirms it is
    // native AND when iNaturalist has no checklist entry for it at all — that
    // default is correct for whether a capture counts, but counting the second
    // group as native overstates the diversity of the region.
    //
    // Establishment means is not stored on the catches row, so we re-read it
    // for the distinct taxa in this place: one bulk, ten-minute-cached call,
    // not one per row. Persisting it on the row would remove this hop.
    const caughtTaxa = [...new Set(catches.map((row) => row.taxon_id))]
    const threatTaxa = new Set(threats.map((row) => row.taxon_id))

    let meansByTaxon = new Map()
    let meansAvailable = true
    try {
      meansByTaxon = await getEstablishmentMeans(caughtTaxa, placeId)
    } catch (err) {
      // The score is still worth serving without this. Fall back to the older,
      // looser reading — every catch counts as native — and say so in the
      // response rather than quietly reporting a different metric.
      meansAvailable = false
      console.warn(`[region/score] establishment means lookup failed: ${err.message}`)
    }

    const nativeTaxa = meansAvailable
      ? caughtTaxa.filter((taxonId) => isNativeMeans(meansByTaxon.get(taxonId)))
      : caughtTaxa

    const uniqueNativeSpecies = nativeTaxa.length
    // Caught, but iNaturalist has no establishment means for it here. Not
    // native, not a threat — just unsurveyed, and reported separately so the
    // number is visible rather than silently dropped.
    const uniqueUnclassifiedSpecies = meansAvailable ? caughtTaxa.length - nativeTaxa.length : 0
    // A threat_report is only ever assigned to a confirmed invasive, so this
    // side needs no second look.
    const uniqueInvasiveSpecies = threatTaxa.size
    const contributors = new Set(rows.map((row) => row.user_id)).size

    // Most-reported invasives first — the "what should we go pull up" list.
    const threatsByTaxon = new Map()
    for (const row of threats) {
      const entry = threatsByTaxon.get(row.taxon_id) ?? {
        taxonId: row.taxon_id,
        commonName: row.common_name ?? row.scientific_name,
        reports: 0,
      }
      entry.reports += 1
      threatsByTaxon.set(row.taxon_id, entry)
    }
    const topThreats = [...threatsByTaxon.values()]
      .sort((a, b) => b.reports - a.reports)
      .slice(0, 3)

    const now = Date.now()
    const since = (days) => now - days * 24 * 60 * 60 * 1000
    const inWindow = (row, from, to) => {
      const at = new Date(row.created_at).getTime()
      return at >= from && at < to
    }
    const last7d = rows.filter((row) => inWindow(row, since(7), now)).length
    const prior7d = rows.filter((row) => inWindow(row, since(14), since(7))).length
    const delta7d = last7d - prior7d

    const hasData = rows.length > 0

    // Three components, averaged. Targets are what a healthy region looks like
    // for a weekend hackathon demo, not ecology — tune them once there is real
    // usage to calibrate against.
    const nativeDiversity = hasData
      ? clampPercent((uniqueNativeSpecies / NATIVE_SPECIES_TARGET) * 100)
      : 0
    // Inverted: 100 means nothing invasive has been reported here. It is
    // averaged into the score alongside the other two, so higher must be
    // better for all three or the arithmetic says the opposite of what it means.
    const invasivePressure =
      uniqueNativeSpecies + uniqueInvasiveSpecies > 0
        ? clampPercent(
            (1 - uniqueInvasiveSpecies / (uniqueNativeSpecies + uniqueInvasiveSpecies)) * 100,
          )
        : 0
    const observerActivity = hasData
      ? clampPercent((contributors / CONTRIBUTOR_TARGET) * 100)
      : 0

    const score = hasData
      ? Math.round((nativeDiversity + invasivePressure + observerActivity) / 3)
      : 0

    res.json({
      placeId,
      placeName: await describePlace(placeId),
      score,
      // 'N/A' rather than 'F': an empty region has not scored badly, it has not
      // been surveyed. The client should say so instead of grading it.
      grade: hasData ? gradeFor(score) : 'N/A',
      components: {
        nativeDiversity,
        invasivePressure,
        observerActivity,
      },
      totals: {
        catches: catches.length,
        threatReports: threats.length,
        uniqueNativeSpecies,
        uniqueInvasiveSpecies,
        // Additive: caught species iNaturalist has no establishment means for.
        uniqueUnclassifiedSpecies,
        contributors,
      },
      // False when the establishment means lookup failed and
      // uniqueNativeSpecies has fallen back to counting every caught species.
      speciesClassified: meansAvailable,
      topThreats,
      trend: {
        direction: delta7d > 0 ? 'up' : delta7d < 0 ? 'down' : 'flat',
        delta7d,
      },
      computedAt: new Date().toISOString(),
      source: 'supabase',
    })
  } catch (err) {
    handleRouteError(err, 'region/score', res, next)
  }
})

export default router