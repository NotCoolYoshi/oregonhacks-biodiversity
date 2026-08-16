// Exercises POST /api/catches and GET /api/region/:placeId/score against a
// stubbed fetch, so the route logic is verified without a live Supabase
// project or an iNaturalist round trip.
//
// Same shape as plantnet.test.mjs: stub globalThis.fetch, run assertions, exit
// non-zero on failure. Here the stub has to serve two upstreams — the
// iNaturalist v1 API and Supabase's PostgREST — so it dispatches on hostname
// and keeps the catches table in a plain array.
//
// Requests to the test server itself go through the real fetch, which is
// captured before the stub is installed.

process.env.SUPABASE_URL = 'https://test-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test_key'

// ---------------------------------------------------------------------------
// Auth
//
// requireClerkUser() (server/src/middleware/clerkAuth.js) verifies a real
// RS256 signature via @clerk/backend's networkless "jwtKey" mode — the same
// code path production uses when CLERK_JWT_KEY is set, just pointed at a
// keypair minted for this run instead of one from the Clerk dashboard. This
// exercises actual signature verification, not a stub of our own middleware.
// ---------------------------------------------------------------------------

const crypto = (await import('node:crypto')).default

const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 0x10001,
})

process.env.CLERK_SECRET_KEY = 'sk_test_placeholder' // only isConfigured() reads this; verification uses jwtKey below
// A syntactically valid (but fake) publishable key — @clerk/backend asserts
// the shape of this even in jwtKey mode, though nothing here talks to the
// frontend API it decodes to. Format: pk_test_<base64(frontendApi + "$")>.
process.env.CLERK_PUBLISHABLE_KEY =
  'pk_test_' + Buffer.from('test.clerk.accounts.dev$').toString('base64')
process.env.CLERK_JWT_KEY = testPublicKey.export({ type: 'spki', format: 'pem' })
// No network calls to Clerk from this test run, telemetry included — every
// host but iNaturalist and Supabase is unstubbed below and throws.
process.env.CLERK_TELEMETRY_DISABLED = 'true'

const base64url = (input) => Buffer.from(input).toString('base64url')

/** A Clerk-shaped session JWT for `userId`, signed with the keypair above. */
const signTestToken = (userId, { expiresInSeconds = 3600 } = {}) => {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { sub: userId, iat: now, nbf: now - 5, exp: now + expiresInSeconds }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), testPrivateKey)
  return `${signingInput}.${base64url(signature)}`
}

const realFetch = globalThis.fetch

const express = (await import('express')).default
const { default: router } = await import('../src/routes/api.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Keyed by iNaturalist taxon id. Establishment means is what the route uses to
// decide catch vs threat_report, so each id here is a fixed verdict.
//
// `means` is keyed by place id, because that is the whole point: the same taxon
// is native in one place and unheard of in another, and the route's job is to
// ask about the right one. A place absent from `means` is a place iNaturalist
// has no checklist entry for — which is a real answer ('unknown'), not a gap in
// the fixture.
const TAXA = {
  126887: {
    id: 126887,
    name: 'Berberis aquifolium',
    preferred_common_name: 'Oregon grape',
    rank: 'species',
    observations_count: 68775,
    means: { 10: 'native' },
  },
  61317: {
    id: 61317,
    name: 'Rubus armeniacus',
    preferred_common_name: 'Armenian Blackberry',
    rank: 'species',
    observations_count: 40000,
    means: { 10: 'introduced' },
  },
  48472: {
    id: 48472,
    name: 'Pseudotsuga menziesii',
    preferred_common_name: 'Douglas-fir',
    rank: 'species',
    observations_count: 11078,
    means: { 10: 'native' },
  },
  // No establishment means anywhere: iNaturalist has no checklist entry for
  // this taxon at all. classify() files it as a 'catch' (a species we cannot
  // classify is not evidence of a threat), which is exactly the case that must
  // NOT be counted as a native species.
  42220: {
    id: 42220,
    name: 'Odocoileus hemionus',
    preferred_common_name: 'Mule Deer',
    rank: 'species',
    observations_count: 15640,
    means: {},
  },
  58732: {
    id: 58732,
    name: 'Cytisus scoparius',
    preferred_common_name: 'Scotch broom',
    rank: 'species',
    observations_count: 942,
    // Invasive in Oregon, native in Arizona's neighbour set it is not — but the
    // shape that matters here is that one taxon carries two different verdicts.
    means: { 10: 'invasive' },
  },
  // The regression this whole change is about. A blue palo verde photographed
  // in Phoenix is native there and unlisted in Oregon; checked against the old
  // fixed place id it came back unclassified.
  63603: {
    id: 63603,
    name: 'Parkinsonia florida',
    preferred_common_name: 'Blue palo verde',
    rank: 'species',
    observations_count: 8400,
    means: { 40: 'native' },
  },
  // Introduced to Arizona and native to Oregon, so it cannot be classified
  // correctly in both without reading the place the photo was taken in.
  99001: {
    id: 99001,
    name: 'Test dualis',
    preferred_common_name: 'Dual-status test plant',
    rank: 'species',
    observations_count: 12,
    means: { 10: 'native', 40: 'introduced' },
  },
}

/** A taxon as /v1/taxa returns it when asked about one particular place. */
function taxonForPlace(taxon, placeId) {
  const means = taxon.means?.[Number(placeId)]
  const { means: _means, ...rest } = taxon

  // iNaturalist omits establishment_means entirely rather than nulling it when
  // a place has no checklist entry, and readEstablishmentMeans() reads the
  // absence as 'unknown'. Modelling that exactly is what makes the unclassified
  // cases in this file real.
  if (!means) return rest

  return {
    ...rest,
    establishment_means: { establishment_means: means, place: { id: Number(placeId) } },
  }
}

const NAME_TO_ID = Object.fromEntries(
  Object.values(TAXA).map((taxon) => [taxon.name.toLowerCase(), taxon.id]),
)

// Two places, each with a coordinate inside it, standing in for
// /v1/places/nearby. Oregon is what the app used to assume everywhere; Arizona
// is the case that used to be answered wrong.
//
// `standard` is what the resolver reads, and it is ordered the way iNaturalist
// orders it — continent, country, state, county — so the admin_level
// preference is actually exercised rather than being satisfied by luck.
const PLACES_BY_REGION = {
  oregon: {
    at: { lat: 44.05, lng: -123.08 },
    standard: [
      { id: 97394, name: 'North America', display_name: 'North America', admin_level: -10 },
      { id: 1, name: 'United States', display_name: 'United States', admin_level: 0 },
      { id: 10, name: 'Oregon', display_name: 'Oregon, US', admin_level: 10 },
      { id: 981, name: 'Lane', display_name: 'Lane County, OR, US', admin_level: 20 },
    ],
  },
  arizona: {
    at: { lat: 33.45, lng: -112.07 },
    standard: [
      { id: 97394, name: 'North America', display_name: 'North America', admin_level: -10 },
      { id: 1, name: 'United States', display_name: 'United States', admin_level: 0 },
      { id: 40, name: 'Arizona', display_name: 'Arizona, US', admin_level: 10 },
      { id: 1861, name: 'Maricopa', display_name: 'Maricopa County, US, AZ', admin_level: 20 },
    ],
  },
  // Mid-Pacific: iNaturalist has no standard place here, which is the case the
  // resolver has to answer with null rather than a guess.
  ocean: { at: { lat: 0, lng: -160 }, standard: [] },
}

const ALL_STANDARD_PLACES = Object.values(PLACES_BY_REGION).flatMap((r) => r.standard)

/** The seeded region whose coordinate falls inside the requested bbox. */
const regionForBbox = (url) => {
  const swlat = Number(url.searchParams.get('swlat'))
  const nelat = Number(url.searchParams.get('nelat'))
  const swlng = Number(url.searchParams.get('swlng'))
  const nelng = Number(url.searchParams.get('nelng'))

  return Object.values(PLACES_BY_REGION).find(
    ({ at }) => at.lat >= swlat && at.lat <= nelat && at.lng >= swlng && at.lng <= nelng,
  )
}

// Stands in for public.catches.
let table = []
let nextId = 1

// Stands in for public.users (migration 003). Separate array, no foreign key
// between them — same as the real schema, which is what lets GET /api/users
// aggregate catches for a user that has no row here.
let usersTable = []

// Stands in for public.sightings (migration 005) — the scoring log every
// POST /api/catches writes to, independent of whether it also touched `table`.
let sightingsTable = []

const resetTable = () => {
  table = []
  usersTable = []
  sightingsTable = []
  storage = new Map()
  nextId = 1
}

/** The array backing a `/rest/v1/<name>` path, or undefined if unstubbed. */
const storeFor = (name) =>
  name === 'catches' ? table
  : name === 'users' ? usersTable
  : name === 'sightings' ? sightingsTable
  : undefined

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// ---------------------------------------------------------------------------
// Upstream stubs
// ---------------------------------------------------------------------------

// Flipped on to exercise the score route's degradation path when iNaturalist
// cannot be reached.
let failTaxaLookup = false

function handleINaturalist(url) {
  // /v1/places/nearby?nelat=&nelng=&swlat=&swlng=  — coordinates to a place.
  if (url.pathname === '/v1/places/nearby') {
    const region = regionForBbox(url)
    return json({ results: { standard: region?.standard ?? [], community: [] } })
  }

  // /v1/places/:id — a place id to its name.
  const place = url.pathname.match(/^\/v1\/places\/(\d+)$/)
  if (place) {
    const found = ALL_STANDARD_PLACES.find((p) => p.id === Number(place[1]))
    return json({ total_results: found ? 1 : 0, results: found ? [found] : [] })
  }

  // /v1/taxa/:id  (one or more comma-separated ids)
  const detail = url.pathname.match(/^\/v1\/taxa\/([\d,]+)$/)
  if (detail) {
    if (failTaxaLookup) return json({ error: 'upstream is down' }, 500)
    const placeId = url.searchParams.get('place_id')
    const ids = detail[1].split(',').map(Number)
    const results = ids
      .map((id) => TAXA[id])
      .filter(Boolean)
      .map((taxon) => taxonForPlace(taxon, placeId))
    return json({ total_results: results.length, results })
  }

  // /v1/taxa?q=<scientific name>
  if (url.pathname === '/v1/taxa') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const id = NAME_TO_ID[q]
    return json({ total_results: id ? 1 : 0, results: id ? [taxonForPlace(TAXA[id])] : [] })
  }

  return json({ error: `unstubbed iNaturalist path ${url.pathname}` }, 404)
}

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------

// Every object uploaded this run, keyed by path, so the tests can assert what
// was stored rather than only what the response claimed.
let storage = new Map()

// Flipped on to exercise the route's behaviour when the bucket is missing —
// the failure a teammate who skipped `npm run setup:storage` actually gets.
let bucketMissing = false

/**
 * The one storage call this app makes: POST an object into a bucket.
 *
 * getPublicUrl() builds its URL client-side from SUPABASE_URL and never
 * reaches the network, so it needs no stub — but that also means the URL a
 * test sees is the real format, which is worth asserting on.
 */
function handleStorage(url, init) {
  const match = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/)
  if (!match) return json({ message: `unstubbed storage path ${url.pathname}` }, 404)

  const [, bucket, path] = match

  if (bucketMissing) return json({ message: 'Bucket not found', error: 'Bucket not found' }, 404)
  if (bucket !== 'catch-photos') return json({ message: 'Bucket not found' }, 404)

  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') {
    return json({ message: `unstubbed storage method ${init?.method}` }, 405)
  }

  // The service uploads a Buffer, which supabase-js sends as the raw body.
  const body = init.body
  const bytes = body?.byteLength ?? body?.length ?? 0

  if (storage.has(path)) return json({ message: 'The resource already exists' }, 409)
  storage.set(path, { bucket, bytes })

  return json({ Key: `${bucket}/${path}` }, 200)
}

/** A 1x1 JPEG, as the client would send it after compressImage(). */
const JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB' +
  '/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKrAB//Z'

/** `col=eq.value` filters, applied in place — the returned rows are references. */
function applyEqFilters(rows, url) {
  let out = [...rows]
  for (const [key, value] of url.searchParams) {
    if (['select', 'limit', 'offset', 'order'].includes(key)) continue
    if (!value.startsWith('eq.')) continue
    const wanted = value.slice(3)
    out = out.filter((row) => String(row[key]) === wanted)
  }
  return out
}

/**
 * A very small slice of PostgREST: `col=eq.value` filters, `limit`, `order`,
 * PATCH, and `Prefer: return=representation` on insert. That is everything the
 * routes under test actually use.
 */
async function handlePostgrest(url, init) {
  const tableName = url.pathname.match(/^\/rest\/v1\/([^/?]+)/)?.[1]
  const store = storeFor(tableName)
  if (!store) {
    return json({ message: `unstubbed table ${url.pathname}` }, 404)
  }

  const method = (init?.method ?? 'GET').toUpperCase()

  // supabase-js may hand us a Headers instance, a plain object, or an array of
  // pairs. `.single()` is signalled purely through Accept, so read it robustly
  // or every single() call silently receives an array instead of a row.
  const headerValue = (name) => {
    const headers = init?.headers
    if (!headers) return ''
    if (typeof headers.get === 'function') return headers.get(name) ?? ''
    const entries = Array.isArray(headers) ? headers : Object.entries(headers)
    const hit = entries.find(([key]) => String(key).toLowerCase() === name.toLowerCase())
    return hit ? String(hit[1]) : ''
  }

  const wantsObject = headerValue('Accept').includes('vnd.pgrst.object')

  if (method === 'POST') {
    const payload = JSON.parse(init.body)
    const rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
      // public.users is keyed by user_id and has no surrogate id column.
      ...(tableName === 'catches' || tableName === 'sightings' ? { id: `row_${nextId++}` } : {}),
      created_at: new Date().toISOString(),
      ...row,
    }))

    // The unique index from migration 002 on catches, and the primary key on
    // users — both enforced here so the race paths are reachable in a test.
    // `sightings` (migration 005) has no unique constraint at all — repeats
    // of the same (user, taxon, place) on the same day are exactly what it is
    // for — so it falls through to `clash: null` and is never rejected here.
    for (const row of rows) {
      const clash =
        tableName === 'users'
          ? store.find((existing) => existing.user_id === row.user_id)
          : tableName === 'catches'
            ? store.find(
                (existing) =>
                  existing.user_id === row.user_id &&
                  Number(existing.taxon_id) === Number(row.taxon_id) &&
                  Number(existing.place_id) === Number(row.place_id),
              )
            : null
      if (clash) {
        const constraint =
          tableName === 'users' ? 'users_pkey' : 'catches_user_taxon_place_uniq'
        return json(
          {
            code: '23505',
            message: `duplicate key value violates unique constraint "${constraint}"`,
          },
          409,
        )
      }
      store.push(row)
    }

    return json(wantsObject ? rows[0] : rows, 201)
  }

  if (method === 'PATCH') {
    const patch = JSON.parse(init.body)
    // applyEqFilters hands back references into `store`, so assigning onto
    // them updates the table — which is the whole point of an UPDATE.
    const matched = applyEqFilters(store, url)
    for (const row of matched) Object.assign(row, patch)
    return json(wantsObject ? (matched[0] ?? null) : matched)
  }

  // GET — apply the eq filters, then the limit.
  let rows = applyEqFilters(store, url)

  // `order=col.asc` / `order=col.desc`. Only a single key, which is all the
  // routes ask for — without this the list route's "newest first" contract
  // would be asserted against whatever order the fixtures happened to be
  // pushed in.
  const order = url.searchParams.get('order')
  if (order) {
    const [column, direction = 'asc'] = order.split('.')
    const sign = direction.startsWith('desc') ? -1 : 1
    rows.sort((a, b) => {
      if (a[column] === b[column]) return 0
      return (a[column] < b[column] ? -1 : 1) * sign
    })
  }

  const limit = Number(url.searchParams.get('limit'))
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit)

  // Honour `select=` as a projection. Real PostgREST returns only the named
  // columns; a stub that returns whole rows lets a route claim to withhold a
  // column while the test sees it anyway.
  const select = url.searchParams.get('select')
  if (select && select !== '*') {
    const columns = select.split(',').map((c) => c.trim()).filter(Boolean)
    rows = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))
  }

  return json(wantsObject ? (rows[0] ?? null) : rows)
}

globalThis.fetch = async (input, init) => {
  // Callers pass all three forms: services/inaturalist.js builds a URL object,
  // supabase-js passes a string, and Request turns up via realFetch.
  const href =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href)

  // Requests to the test server are real.
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return realFetch(input, init)
  }
  if (url.hostname === 'api.inaturalist.org') return handleINaturalist(url)
  if (url.hostname.endsWith('supabase.co')) {
    return url.pathname.startsWith('/storage/')
      ? handleStorage(url, init)
      : handlePostgrest(url, init)
  }

  throw new Error(`unstubbed host ${url.hostname}`)
}

// ---------------------------------------------------------------------------
// Test server + harness
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json())
app.use('/api', router)

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

/**
 * POST /api/catches, authenticated by default.
 *
 * `token` defaults to a session for `body.userId` (falling back to 'usr_1')
 * — this is what every pre-auth test in this file already sends as "who I
 * am", so signing a token to match keeps them all exercising the same
 * behaviour they did before requireClerkUser() existed. Pass `token: null`
 * to test the unauthenticated path, or an explicit token to test a caller
 * whose session doesn't match the userId it claims in the body.
 */
const post = async (body, { token } = {}) => {
  const authToken = token === null ? null : (token ?? signTestToken(body.userId ?? 'usr_1'))
  const res = await realFetch(`${base}/api/catches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const getScore = async (placeId) => {
  const res = await realFetch(`${base}/api/region/${placeId}/score`)
  return { status: res.status, body: await res.json() }
}

const listCatches = async (query = '') => {
  const res = await realFetch(`${base}/api/catches${query}`)
  return { status: res.status, body: await res.json() }
}

const getStatus = async (query) => {
  const res = await realFetch(`${base}/api/species/${query}`)
  return { status: res.status, body: await res.json() }
}

const resolvePlace = async (query) => {
  const res = await realFetch(`${base}/api/places/resolve${query}`)
  return { status: res.status, body: await res.json() }
}

const IN_OREGON = PLACES_BY_REGION.oregon.at
const IN_ARIZONA = PLACES_BY_REGION.arizona.at

const CATCH = { userId: 'usr_1', placeId: 10, location: IN_OREGON }

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The place a request is about, which decides which checklist the
// native/invasive verdict is read from. Everything used to be Oregon.
// ---------------------------------------------------------------------------

console.log('\n-- coordinates resolve to a place --')

let p = await resolvePlace(`?lat=${IN_OREGON.lat}&lng=${IN_OREGON.lng}`)
check('Oregon coordinates resolve to Oregon', p.body.placeId === 10, p.body.placeId)
check('...named from iNaturalist display_name', p.body.placeName === 'Oregon, US', p.body.placeName)

p = await resolvePlace(`?lat=${IN_ARIZONA.lat}&lng=${IN_ARIZONA.lng}`)
check('Arizona coordinates resolve to Arizona, not Oregon', p.body.placeId === 40, p.body.placeId)
check('...named correctly', p.body.placeName === 'Arizona, US', p.body.placeName)

// State over county over country: county checklists are mostly empty, so the
// most precise place is not the most useful one.
check('the state level is preferred over the county', p.body.adminLevel === 10, p.body.adminLevel)

p = await resolvePlace('?lat=0&lng=-160')
check('coordinates in no standard place -> 404', p.status === 404, p.status)
check('...coded PLACE_NOT_FOUND', p.body.code === 'PLACE_NOT_FOUND', p.body.code)

p = await resolvePlace('?lat=44.05')
check('missing lng -> 400', p.status === 400, p.status)
p = await resolvePlace('?lat=999&lng=-123')
check('out-of-range lat -> 400', p.status === 400, p.status)

console.log('\n-- the verdict follows the coordinates, not a fixed region --')

// The reported bug, end to end: a blue palo verde photographed in Phoenix.
// Against Oregon's checklist it is unlisted; against Arizona's it is native.
let s = await getStatus(`63603/status?lat=${IN_ARIZONA.lat}&lng=${IN_ARIZONA.lng}`)
check('palo verde in Arizona is checked against Arizona', s.body.placeId === 40, s.body.placeId)
check('...and comes back native', s.body.establishmentMeans === 'native', s.body.establishmentMeans)
check('...as a catch', s.body.classification === 'catch', s.body.classification)
check('...with the place derived from coordinates',
  s.body.placeSource === 'coordinates', s.body.placeSource)

s = await getStatus(`63603/status?lat=${IN_OREGON.lat}&lng=${IN_OREGON.lng}`)
check('the same plant in Oregon is unlisted there',
  s.body.placeId === 10 && s.body.establishmentMeans === 'unknown',
  `${s.body.placeId} ${s.body.establishmentMeans}`)

// One taxon, two verdicts. Nothing but the coordinates differs between these.
s = await getStatus(`99001/status?lat=${IN_OREGON.lat}&lng=${IN_OREGON.lng}`)
check('a dual-status taxon is native in Oregon',
  s.body.establishmentMeans === 'native' && s.body.classification === 'catch',
  `${s.body.establishmentMeans} ${s.body.classification}`)

s = await getStatus(`99001/status?lat=${IN_ARIZONA.lat}&lng=${IN_ARIZONA.lng}`)
check('...and introduced in Arizona',
  s.body.establishmentMeans === 'introduced' && s.body.classification === 'threat_report',
  `${s.body.establishmentMeans} ${s.body.classification}`)

// A caller that knows its own region still wins, and a caller with nothing to
// go on still gets an answer rather than an error.
s = await getStatus(`99001/status?place_id=40&lat=${IN_OREGON.lat}&lng=${IN_OREGON.lng}`)
check('an explicit place_id overrides the coordinates', s.body.placeId === 40, s.body.placeId)
check('...and says the place was explicit', s.body.placeSource === 'explicit', s.body.placeSource)

s = await getStatus('99001/status')
check('no coordinates falls back rather than failing', s.status === 200, s.status)
check('...to the fallback place', s.body.placeId === 10, s.body.placeId)
check('...and declares it a fallback', s.body.placeSource === 'fallback', s.body.placeSource)

// Coordinates in no place are the same situation as no coordinates: fall back,
// and say so, rather than 404ing a capture.
s = await getStatus('99001/status?lat=0&lng=-160')
check('unresolvable coordinates fall back too',
  s.status === 200 && s.body.placeSource === 'fallback', `${s.status} ${s.body.placeSource}`)

console.log('\n-- catches are classified against where they were taken --')
resetTable()

let r = await post({ userId: 'usr_az', taxonId: 63603, location: IN_ARIZONA })
check('an Arizona catch is stored against Arizona', r.body.placeId === 40, r.body.placeId)
check('...with the resolved place name', r.body.placeName === 'Arizona, US', r.body.placeName)
check('...and the row agrees', table[0].place_id === 40, table[0].place_id)

// Same species, same user, other state: the duplicate rule is per place, so
// this is a second real observation rather than a rejected one.
r = await post({ userId: 'usr_az', taxonId: 99001, location: IN_ARIZONA })
check('a taxon introduced in Arizona is a threat report there',
  r.body.type === 'threat_report', r.body.type)
r = await post({ userId: 'usr_az', taxonId: 99001, location: IN_OREGON })
check('...and the same taxon in Oregon is a catch', r.body.type === 'catch', r.body.type)
check('...recorded in a different place', r.body.placeId === 10, r.body.placeId)

r = await post({ userId: 'usr_az', taxonId: 63603 })
check('a catch with no location still records', r.status === 201, r.status)
check('...against the fallback place, declared as such',
  r.body.placeId === 10 && r.body.placeSource === 'fallback',
  `${r.body.placeId} ${r.body.placeSource}`)

console.log('\n-- type is decided server-side, not by the client --')
resetTable()

// Armenian blackberry is introduced. The client says it caught one.
r = await post({ ...CATCH, taxonId: 61317, type: 'catch' })
check('invasive claimed as catch is stored as threat_report',
  r.status === 201 && r.body.type === 'threat_report', `${r.status} ${r.body.type}`)
check('override is reported via typeCorrected', r.body.typeCorrected === true)
check('override reports what was claimed', r.body.claimedType === 'catch', r.body.claimedType)
check('points follow the server type, not the claim (new threat_report)',
  r.body.pointsAwarded === 50, r.body.pointsAwarded)
check('establishmentMeans surfaced', r.body.establishmentMeans === 'introduced',
  r.body.establishmentMeans)
check('persisted row carries the corrected type', table[0].type === 'threat_report',
  table[0].type)

// ...and the reverse: no farming the higher threat_report points off a native.
r = await post({ ...CATCH, taxonId: 126887, type: 'threat_report' })
check('native claimed as threat_report is stored as catch',
  r.status === 201 && r.body.type === 'catch', `${r.status} ${r.body.type}`)
check('points drop to the catch value (new catch)', r.body.pointsAwarded === 20,
  r.body.pointsAwarded)
check('typeCorrected set on this direction too', r.body.typeCorrected === true)

r = await post({ ...CATCH, taxonId: 48472, type: 'catch' })
check('an honest claim is not flagged as corrected', r.body.typeCorrected === false)
check('claimedType omitted when nothing was corrected', !('claimedType' in r.body))

r = await post({ ...CATCH, taxonId: 58732 })
check('missing type still classified from iNaturalist',
  r.body.type === 'threat_report' && r.body.typeCorrected === false, r.body.type)

// ---------------------------------------------------------------------------
// Catch photos
// ---------------------------------------------------------------------------

console.log('\n-- catch photos are uploaded, not trusted --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887, photoBase64: JPEG_DATA_URL })
check('a catch with a photo is stored', r.status === 201, r.status)
check('exactly one object was uploaded', storage.size === 1, storage.size)

const [storedPath, storedObject] = [...storage.entries()][0]
check('...into the catch-photos bucket', storedObject.bucket === 'catch-photos',
  storedObject.bucket)
check('...foldered under the user', storedPath.startsWith('usr_1/'), storedPath)
// A guessable name in a public bucket lets anyone walk other users' photos.
check('...under a uuid, not anything derived from the catch',
  /^usr_1\/[0-9a-f-]{36}\.jpg$/.test(storedPath), storedPath)
check('...with the decoded bytes, not the base64 text',
  storedObject.bytes > 0 && storedObject.bytes < JPEG_DATA_URL.length, storedObject.bytes)

check('the response carries a photo URL', typeof r.body.photoUrl === 'string', r.body.photoUrl)
check('...pointing into the public bucket',
  r.body.photoUrl.includes(`/storage/v1/object/public/catch-photos/${storedPath}`),
  r.body.photoUrl)
check('...and the row stores it', table[0].photo_url === r.body.photoUrl, table[0].photo_url)

// The client has no bucket credential, so a photoUrl in the body is a claim
// about someone else's storage. The upload path is the only one that writes it.
r = await post({ ...CATCH, taxonId: 48472, photoBase64: JPEG_DATA_URL, photoUrl: 'https://evil.example/x.jpg' })
check('an uploaded photo overrides a client-supplied photoUrl',
  !r.body.photoUrl.includes('evil.example'), r.body.photoUrl)

r = await post({ ...CATCH, taxonId: 58732 })
check('a catch with no photo still records', r.status === 201, r.status)
check('...with a null photo_url', r.body.photoUrl === null, r.body.photoUrl)
check('...and uploads nothing', storage.size === 2, storage.size)

console.log('\n-- catch photos, rejected payloads --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887, photoBase64: 'not-a-data-url' })
check('a non-data-URL photo -> 400', r.status === 400, r.status)
check('...coded BAD_REQUEST', r.body.code === 'BAD_REQUEST', r.body.code)
check('...and writes no row', table.length === 0, table.length)
check('...and stores nothing', storage.size === 0, storage.size)

// The bucket's own mime allowlist would reject this; catching it first buys a
// message that says which format is expected.
r = await post({ ...CATCH, taxonId: 126887, photoBase64: 'data:image/png;base64,iVBORw0KGgo=' })
check('a non-JPEG photo -> 400', r.status === 400, r.status)
check('...naming the format', /JPEG/i.test(r.body.error), r.body.error)

console.log('\n-- catch photos, storage unavailable --')
resetTable()
bucketMissing = true
r = await post({ ...CATCH, taxonId: 126887, photoBase64: JPEG_DATA_URL })
bucketMissing = false

check('a missing bucket -> 500', r.status === 500, r.status)
check('...coded BUCKET_MISSING', r.body.code === 'BUCKET_MISSING', r.body.code)
check('...naming the setup command', /setup:storage/.test(r.body.error), r.body.error)
// The row is written after the upload precisely so this cannot happen: a row
// pointing at an object that was never stored.
check('...and writes no row rather than one with a broken photo',
  table.length === 0, table.length)

console.log('\n-- isFirstCatch --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887 })
check('first ever sighting is a first catch', r.body.isFirstCatch === true)

// Same species, different place: a real observation, but not a new catalogue entry.
r = await post({ ...CATCH, taxonId: 126887, placeId: 962 })
check('same species in a new place still records', r.status === 201, r.status)
check('...but is not a first catch', r.body.isFirstCatch === false)

r = await post({ ...CATCH, taxonId: 61317 })
check('a different species is a first catch again', r.body.isFirstCatch === true)

r = await post({ ...CATCH, userId: 'usr_2', taxonId: 126887 })
check('first catch is per user, not global', r.body.isFirstCatch === true)

console.log('\n-- family + per-family sequential number --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887, family: 'Berberidaceae' })
check('family is persisted', r.body.family === 'Berberidaceae', r.body.family)
check('...and the row agrees', table[0].family === 'Berberidaceae', table[0].family)
check('the first catch in a family is sequence 1', r.body.familySequence === 1,
  r.body.familySequence)

r = await post({ ...CATCH, taxonId: 61317, family: 'Berberidaceae' })
check('a second species in the same family advances the sequence',
  r.body.familySequence === 2, r.body.familySequence)

r = await post({ ...CATCH, taxonId: 48472, family: 'Pinaceae' })
check('a different family starts its own sequence at 1', r.body.familySequence === 1,
  r.body.familySequence)

r = await post({ ...CATCH, userId: 'usr_fam2', taxonId: 126887, family: 'Berberidaceae' })
check('the sequence is per user, not shared across users',
  r.body.familySequence === 1, r.body.familySequence)

r = await post({ ...CATCH, taxonId: 58732 })
check('no family sent -> family is null, not omitted', r.body.family === null, r.body.family)
check('...and familySequence is null, not 0 or omitted',
  r.body.familySequence === null, r.body.familySequence)

r = await post({ ...CATCH, taxonId: 63603, family: '  Fabaceae  ' })
check('family is trimmed before storage', r.body.family === 'Fabaceae', r.body.family)

console.log('\n-- repeats: no more 409, tiered points instead --')
resetTable()

r = await post({ ...CATCH, taxonId: 61317 })
check('first sighting of the day is tier "new"', r.body.tier === 'new', r.body.tier)
check('...worth the new-species threat_report points', r.body.pointsAwarded === 50,
  r.body.pointsAwarded)
check('...and creates a catalogue entry', r.body.newCatalogueEntry === true,
  r.body.newCatalogueEntry)
const before = table.length

r = await post({ ...CATCH, taxonId: 61317 })
check('an exact repeat succeeds instead of 409ing', r.status === 201, r.status)
check('...tiered as repeat_extra (second sighting of this species today)',
  r.body.tier === 'repeat_extra', r.body.tier)
check('...worth the token threat_report amount', r.body.pointsAwarded === 3, r.body.pointsAwarded)
check('...and does not create a new catalogue row',
  r.body.newCatalogueEntry === false, r.body.newCatalogueEntry)
check('...but reports the original catalogue id', r.body.id === table[0].id, r.body.id)
check('no second catches row was written', table.length === before, `${table.length} vs ${before}`)
check('but a sighting was logged for it', sightingsTable.length === 2, sightingsTable.length)
check('the sighting references the catalogue row',
  sightingsTable[1].catch_id === table[0].id, sightingsTable[1].catch_id)

console.log('\n-- repeats: a later day resets to repeat_daily --')
resetTable()

// Simulate this species already being caught on a previous day, with no
// activity yet today.
table.push({
  id: 'row_seed', user_id: 'usr_1', taxon_id: 126887, place_id: 10, type: 'catch',
  common_name: 'Oregon grape', scientific_name: 'Berberis aquifolium',
  created_at: '2026-08-01T00:00:00.000Z',
})
sightingsTable.push({
  id: 'sight_seed', user_id: 'usr_1', taxon_id: 126887, catch_id: 'row_seed', type: 'catch',
  tier: 'new', points_awarded: 20, created_at: '2026-08-01T00:00:00.000Z',
})

r = await post({ ...CATCH, taxonId: 126887 })
check('a repeat on a later day is tier repeat_daily', r.body.tier === 'repeat_daily', r.body.tier)
check('...worth the daily-repeat catch points (no streak carried over the gap)',
  r.body.pointsAwarded === 10, r.body.pointsAwarded)
check('...and still no new catalogue row', r.body.newCatalogueEntry === false,
  r.body.newCatalogueEntry)
check('no second catches row was written', table.length === 1, table.length)

console.log('\n-- streak multiplier --')
resetTable()

// A synthetic 12-day streak ending yesterday, one sighting per day.
for (let d = 12; d >= 1; d--) {
  const day = new Date()
  day.setUTCDate(day.getUTCDate() - d)
  sightingsTable.push({
    id: `streak_${d}`, user_id: 'usr_streak', taxon_id: 900000 + d, catch_id: null,
    type: 'catch', tier: 'new', points_awarded: 20, created_at: day.toISOString(),
  })
}

r = await post({ ...CATCH, userId: 'usr_streak', taxonId: 126887 })
check('today extends the streak to 13 consecutive days', r.body.streakDays === 13, r.body.streakDays)
check('floor(13/5) * 0.1 -> a 1.2x multiplier', r.body.streakMultiplier === 1.2,
  r.body.streakMultiplier)
check('applied to the new-catch base (20 * 1.2 = 24)', r.body.pointsAwarded === 24,
  r.body.pointsAwarded)

console.log('\n-- request validation --')
// userId is no longer a body field to validate — see the auth section below;
// requireClerkUser() rejects an unauthenticated request before this check
// ever runs, and an authenticated one always has a userId (Clerk's).
r = await post({ userId: 'usr_1' })
check('missing taxonId and scientificName -> 400', r.status === 400, r.status)

resetTable()
r = await post({ ...CATCH, scientificName: 'Rubus armeniacus' })
check('scientificName resolves to a taxon id', r.body.taxonId === 61317, r.body.taxonId)
check('resolved species is still classified server-side', r.body.type === 'threat_report')

console.log('\n-- auth: POST /api/catches --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887 }, { token: null })
check('no Authorization header -> 401', r.status === 401, r.status)
check('...coded UNAUTHENTICATED', r.body.code === 'UNAUTHENTICATED', r.body.code)
check('an unauthenticated request writes nothing', table.length === 0, table.length)

r = await post({ ...CATCH, taxonId: 126887 }, { token: 'not-a-real-jwt' })
check('a garbage token -> 401', r.status === 401, r.status)

// The body's userId is not the identity written — see requireClerkUser() and
// the "Clerk's, not the body's" note on the route itself. A caller signed in
// as usr_verified but claiming usr_spoofed in the body must not be able to
// write into usr_spoofed's catalogue.
r = await post(
  { ...CATCH, userId: 'usr_spoofed', taxonId: 126887 },
  { token: signTestToken('usr_verified') },
)
check('the row is written under the token\'s userId', r.body.userId === 'usr_verified', r.body.userId)
check('...not the body\'s claimed userId', r.body.userId !== 'usr_spoofed', r.body.userId)
check('...and that is what actually landed in the table',
  table.some((row) => row.user_id === 'usr_verified'), JSON.stringify(table))
check('nothing was written under the spoofed id',
  !table.some((row) => row.user_id === 'usr_spoofed'), JSON.stringify(table))

const savedClerkSecretKey = process.env.CLERK_SECRET_KEY
delete process.env.CLERK_SECRET_KEY
r = await post({ ...CATCH, taxonId: 126887 })
check('Clerk unconfigured -> 503, not a crash', r.status === 503, r.status)
check('...coded AUTH_NOT_CONFIGURED', r.body.code === 'AUTH_NOT_CONFIGURED', r.body.code)
process.env.CLERK_SECRET_KEY = savedClerkSecretKey

console.log('\n-- region score aggregate --')
resetTable()

// Two native species across two users, two invasive species across three,
// plus one row in a different place that must not be counted.
const seed = (user_id, taxon_id, type, place_id = 10) =>
  table.push({
    id: `row_${nextId++}`,
    user_id,
    taxon_id,
    type,
    place_id,
    common_name: TAXA[taxon_id].preferred_common_name,
    scientific_name: TAXA[taxon_id].name,
    created_at: new Date().toISOString(),
  })

// Seeds `sightings` directly, bypassing POST /api/catches's tier/streak
// math — for tests that only care what GET /api/users/:userId and
// GET /api/leaderboard do with points_awarded once it already exists.
const seedSighting = (user_id, taxon_id, type, points_awarded, at = new Date().toISOString()) =>
  sightingsTable.push({
    id: `sight_${nextId++}`,
    user_id,
    taxon_id,
    catch_id: null,
    type,
    tier: 'new',
    points_awarded,
    created_at: at,
  })

seed('usr_1', 126887, 'catch')
seed('usr_2', 126887, 'catch') // same species — must not double-count
seed('usr_1', 48472, 'catch')
seed('usr_1', 61317, 'threat_report')
seed('usr_2', 61317, 'threat_report') // same threat — two reports, one species
seed('usr_3', 58732, 'threat_report')
seed('usr_9', 126887, 'catch', 962) // different place — must be excluded

r = await getScore(10)
check('unique native species counted distinctly', r.body.totals.uniqueNativeSpecies === 2,
  r.body.totals.uniqueNativeSpecies)
check('unique invasive species counted distinctly', r.body.totals.uniqueInvasiveSpecies === 2,
  r.body.totals.uniqueInvasiveSpecies)
check('contributors counted distinctly', r.body.totals.contributors === 3,
  r.body.totals.contributors)
check('catches counted', r.body.totals.catches === 3, r.body.totals.catches)
check('threat reports counted', r.body.totals.threatReports === 3, r.body.totals.threatReports)
check('other places excluded', r.body.totals.catches === 3 && r.body.totals.contributors === 3)

check('topThreats ranked by report count',
  r.body.topThreats[0].taxonId === 61317 && r.body.topThreats[0].reports === 2,
  JSON.stringify(r.body.topThreats))
check('topThreats names the species', r.body.topThreats[0].commonName === 'Armenian Blackberry',
  r.body.topThreats[0].commonName)

// nativeDiversity  = round(2/50*100)        = 4
// invasivePressure = round((1 - 2/4) * 100) = 50
// observerActivity = round(3/15*100)        = 20
check('nativeDiversity scaled to target', r.body.components.nativeDiversity === 4,
  r.body.components.nativeDiversity)
check('invasivePressure inverted (higher = less pressure)',
  r.body.components.invasivePressure === 50, r.body.components.invasivePressure)
check('observerActivity scaled to target', r.body.components.observerActivity === 20,
  r.body.components.observerActivity)
check('score is the mean of the three components', r.body.score === 25, r.body.score)
check('grade derived from score', r.body.grade === 'F', r.body.grade)
check('source reports the database', r.body.source === 'supabase', r.body.source)
check('all-native fixture reports nothing unclassified',
  r.body.totals.uniqueUnclassifiedSpecies === 0, r.body.totals.uniqueUnclassifiedSpecies)
check('classification succeeded', r.body.speciesClassified === true)

// The bug this guards: classify() files a taxon iNaturalist has no checklist
// entry for as a 'catch', which is right for whether the capture counts and
// wrong for whether the species is native. Counting those as native inflated
// uniqueNativeSpecies and, through it, nativeDiversity and the score.
console.log('\n-- native count excludes unclassified species --')
resetTable()

seed('usr_1', 126887, 'catch') // confirmed native
seed('usr_1', 48472, 'catch') // confirmed native
seed('usr_2', 42220, 'catch') // NO establishment means — must not count as native
seed('usr_2', 61317, 'threat_report') // confirmed invasive

r = await getScore(10)
check('only confirmed-native species count', r.body.totals.uniqueNativeSpecies === 2,
  r.body.totals.uniqueNativeSpecies)
check('unclassified species are reported separately',
  r.body.totals.uniqueUnclassifiedSpecies === 1, r.body.totals.uniqueUnclassifiedSpecies)
check('the unclassified species is still a catch', r.body.totals.catches === 3,
  r.body.totals.catches)
check('invasive count is unaffected', r.body.totals.uniqueInvasiveSpecies === 1,
  r.body.totals.uniqueInvasiveSpecies)
// nativeDiversity  = round(2/50*100)            = 4   (not 6 — that was the bug)
// invasivePressure = round((1 - 1/(2+1)) * 100) = 67
// observerActivity = round(2/15*100)            = 13
check('nativeDiversity reflects only confirmed natives',
  r.body.components.nativeDiversity === 4, r.body.components.nativeDiversity)
check('invasivePressure denominator excludes unclassified',
  r.body.components.invasivePressure === 67, r.body.components.invasivePressure)
check('score follows the corrected components', r.body.score === 28, r.body.score)

console.log('\n-- every catch unclassified --')
resetTable()
seed('usr_1', 42220, 'catch')
seed('usr_2', 42220, 'catch')

r = await getScore(10)
check('no species counts as native', r.body.totals.uniqueNativeSpecies === 0,
  r.body.totals.uniqueNativeSpecies)
check('all of them count as unclassified', r.body.totals.uniqueUnclassifiedSpecies === 1,
  r.body.totals.uniqueUnclassifiedSpecies)
check('the catches themselves still count', r.body.totals.catches === 2, r.body.totals.catches)
check('nativeDiversity is 0', r.body.components.nativeDiversity === 0,
  r.body.components.nativeDiversity)
check('invasivePressure is 0 with nothing classified either way',
  r.body.components.invasivePressure === 0, r.body.components.invasivePressure)
// observerActivity = round(2/15*100) = 13 -> score = round(13/3) = 4
check('score falls to the observer component alone', r.body.score === 4, r.body.score)
check('a region of unknowns is still graded, not N/A', r.body.grade === 'F', r.body.grade)

console.log('\n-- iNaturalist unreachable during aggregation --')
resetTable()
// place 999 so the per-taxon means cache from earlier sections cannot serve it.
seed('usr_1', 126887, 'catch', 999)
seed('usr_2', 42220, 'catch', 999)
failTaxaLookup = true
r = await getScore(999)
failTaxaLookup = false

check('the score is still served', r.status === 200, r.status)
check('degradation is declared, not hidden', r.body.speciesClassified === false,
  r.body.speciesClassified)
check('falls back to counting every caught species', r.body.totals.uniqueNativeSpecies === 2,
  r.body.totals.uniqueNativeSpecies)
check('no unclassified count is claimed when it could not be determined',
  r.body.totals.uniqueUnclassifiedSpecies === 0, r.body.totals.uniqueUnclassifiedSpecies)

console.log('\n-- region score, no data --')
resetTable()
r = await getScore(10)
check('empty region scores 0', r.body.score === 0, r.body.score)
check('empty region grades N/A rather than F', r.body.grade === 'N/A', r.body.grade)
check('empty region reports zero totals',
  r.body.totals.catches === 0 && r.body.totals.contributors === 0)
check('empty region reports zero unclassified',
  r.body.totals.uniqueUnclassifiedSpecies === 0, r.body.totals.uniqueUnclassifiedSpecies)
check('empty region needs no lookup to classify nothing',
  r.body.speciesClassified === true, r.body.speciesClassified)
check('empty region has no top threats', r.body.topThreats.length === 0)
check('empty region trend is flat', r.body.trend.direction === 'flat', r.body.trend.direction)

r = await getScore('not-a-place')
check('non-numeric placeId -> 400', r.status === 400, r.status)

// ---------------------------------------------------------------------------
// GET /api/catches — the list endpoint behind the map and the catalogue.
// ---------------------------------------------------------------------------

// Seeds a row directly, so lat/lng and created_at can be set per row. The
// score section's seed() fixes both, and this section needs to vary them.
const seedRow = ({ user_id, taxon_id, type, place_id = 10, lat = null, lng = null, at }) =>
  table.push({
    id: `row_${nextId++}`,
    user_id,
    taxon_id,
    type,
    place_id,
    place_name: place_id === 10 ? 'Oregon' : 'Lane County, OR',
    common_name: TAXA[taxon_id].preferred_common_name,
    scientific_name: TAXA[taxon_id].name,
    lat,
    lng,
    created_at: at,
  })

console.log('\n-- list catches, empty --')
resetTable()

let l = await listCatches()
check('empty table -> 200', l.status === 200, l.status)
check('empty table returns an empty array', Array.isArray(l.body.catches) && l.body.catches.length === 0,
  JSON.stringify(l.body.catches))
check('empty table reports zero totalResults', l.body.totalResults === 0, l.body.totalResults)

l = await listCatches('?placeId=10')
check('empty result for a filtered place is still 200', l.status === 200, l.status)
check('...with an empty array, not null', Array.isArray(l.body.catches) && l.body.catches.length === 0)

console.log('\n-- list catches, filters --')
resetTable()

// usr_1: two rows in place 10, one in place 962.
// usr_2: one row in place 10.
seedRow({ user_id: 'usr_1', taxon_id: 126887, type: 'catch', at: '2026-08-01T00:00:00.000Z',
  lat: 44.05, lng: -123.08 })
seedRow({ user_id: 'usr_1', taxon_id: 61317, type: 'threat_report', at: '2026-08-03T00:00:00.000Z',
  lat: 45.51, lng: -122.67 })
seedRow({ user_id: 'usr_1', taxon_id: 48472, type: 'catch', place_id: 962,
  at: '2026-08-02T00:00:00.000Z', lat: 44.0, lng: -123.1 })
seedRow({ user_id: 'usr_2', taxon_id: 58732, type: 'threat_report', at: '2026-08-04T00:00:00.000Z',
  lat: 42.32, lng: -122.87 })

l = await listCatches()
check('no filters returns every row', l.body.totalResults === 4, l.body.totalResults)
check('newest first', l.body.catches[0].taxon_id === 58732, l.body.catches[0].taxon_id)
check('oldest last', l.body.catches[3].taxon_id === 126887, l.body.catches[3].taxon_id)

l = await listCatches('?userId=usr_1')
check('userId filter returns only that user', l.body.totalResults === 3, l.body.totalResults)
check('userId filter spans places', l.body.catches.some((row) => row.taxon_id === 48472))
check('userId echoed back', l.body.userId === 'usr_1', l.body.userId)
check('placeId null when not filtered', l.body.placeId === null, l.body.placeId)

l = await listCatches('?placeId=10')
check('placeId filter returns only that place', l.body.totalResults === 3, l.body.totalResults)
check('placeId filter spans users',
  l.body.catches.some((row) => row.taxon_id === 126887) &&
    l.body.catches.some((row) => row.taxon_id === 58732),
  JSON.stringify(l.body.catches.map((row) => row.taxon_id)))
check('the other place is excluded', !l.body.catches.some((row) => row.taxon_id === 48472))
check('placeId echoed back as a number', l.body.placeId === 10, l.body.placeId)
// Named from iNaturalist rather than from the three-entry map in mocks.js.
// display_name and not name: "Lane" is not a place anyone can find, and as
// soon as the app spans two states "Oregon" alone stops being enough either.
check('placeName resolved for the filtered place', l.body.placeName === 'Oregon, US',
  l.body.placeName)

l = await listCatches('?userId=usr_1&placeId=10')
check('both filters AND together', l.body.totalResults === 2, l.body.totalResults)
check('both filters exclude the other user',
  !l.body.catches.some((row) => row.taxon_id === 58732))
check('both filters exclude the other place',
  !l.body.catches.some((row) => row.taxon_id === 48472))

l = await listCatches('?userId=usr_nobody')
check('unknown user returns empty, not 404', l.status === 200 && l.body.totalResults === 0,
  `${l.status} ${l.body.totalResults}`)

console.log('\n-- list catches, row shape --')
l = await listCatches('?userId=usr_1&placeId=10')
const row = l.body.catches[0]
for (const field of ['id', 'taxon_id', 'scientific_name', 'common_name', 'type', 'lat', 'lng',
  'place_id', 'place_name', 'photo_url', 'created_at']) {
  check(`row carries ${field}`, field in row, JSON.stringify(row))
}
// user_id is the one column here that identifies a person. photo_url used to
// be withheld alongside it, but for a different reason — it was always null.
// Now that catches carry photos the catalogue needs it, and the bucket is
// public-read, so the URL grants nothing the object does not already.
check('row does not leak user_id', !('user_id' in row), JSON.stringify(row))

// The map filters these out client-side; the endpoint must not do it for it,
// or the catalogue silently loses every catch logged without geolocation.
console.log('\n-- list catches, null coordinates are still returned --')
resetTable()

seedRow({ user_id: 'usr_1', taxon_id: 126887, type: 'catch', at: '2026-08-01T00:00:00.000Z',
  lat: 44.05, lng: -123.08 })
seedRow({ user_id: 'usr_1', taxon_id: 61317, type: 'threat_report', at: '2026-08-02T00:00:00.000Z' })
seedRow({ user_id: 'usr_1', taxon_id: 48472, type: 'catch', at: '2026-08-03T00:00:00.000Z' })

l = await listCatches('?userId=usr_1')
check('rows with null lat/lng are returned', l.body.totalResults === 3, l.body.totalResults)
check('two of them have no coordinates',
  l.body.catches.filter((r) => r.lat === null && r.lng === null).length === 2,
  JSON.stringify(l.body.catches.map((r) => r.lat)))
check('the located row survives alongside them',
  l.body.catches.some((r) => r.lat === 44.05), JSON.stringify(l.body.catches.map((r) => r.lat)))

l = await listCatches('?placeId=10')
check('null coordinates survive the placeId filter too', l.body.totalResults === 3,
  l.body.totalResults)

console.log('\n-- list catches, validation --')
l = await listCatches('?placeId=not-a-place')
check('non-numeric placeId -> 400', l.status === 400, l.status)
check('...coded BAD_REQUEST', l.body.code === 'BAD_REQUEST', l.body.code)
l = await listCatches('?placeId=0')
check('placeId=0 -> 400', l.status === 400, l.status)
l = await listCatches('?placeId=')
check('empty placeId is treated as absent, not invalid', l.status === 200, l.status)

// ---------------------------------------------------------------------------
// POST /api/users and GET /api/users/:userId — the display name behind the
// profile header, plus the aggregates it renders.
// ---------------------------------------------------------------------------

/** POST /api/users, authenticated by default. Same `token` override as post(). */
const postUser = async (body, { token } = {}) => {
  const authToken = token === null ? null : (token ?? signTestToken(body.userId ?? 'usr_1'))
  const res = await realFetch(`${base}/api/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const getUser = async (userId) => {
  const res = await realFetch(`${base}/api/users/${encodeURIComponent(userId)}`)
  return { status: res.status, body: await res.json() }
}

const storedUser = (userId) => usersTable.find((entry) => entry.user_id === userId)

console.log('\n-- upsert a user --')
resetTable()

let u = await postUser({ userId: 'usr_1' })
check('first upsert creates the row', u.status === 201, u.status)
check('...and reports it as created', u.body.created === true, u.body.created)
check('...writing exactly one row', usersTable.length === 1, usersTable.length)
check('...keyed by the userId given', storedUser('usr_1') !== undefined,
  JSON.stringify(usersTable))
check('a default displayName is generated', /^Explorer \d{4}$/.test(u.body.displayName ?? ''),
  u.body.displayName)
check('the generated name is what got persisted',
  storedUser('usr_1').display_name === u.body.displayName, storedUser('usr_1').display_name)

const generated = u.body.displayName

// session.js calls this on every load, so the no-name path has to be inert.
u = await postUser({ userId: 'usr_1' })
check('re-upserting without a name is not a create',
  u.status === 200 && u.body.created === false, `${u.status} ${u.body.created}`)
check('...and keeps the name already there', u.body.displayName === generated, u.body.displayName)
check('...and adds no second row', usersTable.length === 1, usersTable.length)

u = await postUser({ userId: 'usr_1', displayName: 'Fern Hunter' })
check('upsert with a displayName renames', u.body.displayName === 'Fern Hunter', u.body.displayName)
check('...in the table, not just the response',
  storedUser('usr_1').display_name === 'Fern Hunter', storedUser('usr_1').display_name)
check('...without inserting a duplicate', usersTable.length === 1, usersTable.length)

u = await postUser({ userId: 'usr_2', displayName: 'Moss Boss' })
check('a new user may name itself on creation',
  u.status === 201 && u.body.displayName === 'Moss Boss', `${u.status} ${u.body.displayName}`)
check('the other user is untouched', storedUser('usr_1').display_name === 'Fern Hunter',
  storedUser('usr_1').display_name)

// Someone clearing the rename field and submitting keeps what they had.
u = await postUser({ userId: 'usr_1', displayName: '   ' })
check('a blank displayName leaves the name alone', u.body.displayName === 'Fern Hunter',
  u.body.displayName)
u = await postUser({ userId: 'usr_1', displayName: '  Trailing Space  ' })
check('displayName is trimmed', u.body.displayName === 'Trailing Space',
  JSON.stringify(u.body.displayName))

console.log('\n-- upsert validation --')
// userId is no longer a body field to validate — see the auth section below.
// requireClerkUser() supplies it from the verified token, which is always a
// non-empty string, so there is no "missing"/"blank" case left to reject.
u = await postUser({ userId: 'usr_1', displayName: 'x'.repeat(61) })
check('over-long displayName -> 400', u.status === 400, u.status)
check('...and the stored name survives the rejection',
  storedUser('usr_1').display_name === 'Trailing Space', storedUser('usr_1').display_name)
u = await postUser({ userId: 'usr_1', displayName: 'x'.repeat(60) })
check('exactly at the limit is accepted', u.status === 200, u.status)

console.log('\n-- auth: POST /api/users --')

u = await postUser({ userId: 'usr_1' }, { token: null })
check('no Authorization header -> 401', u.status === 401, u.status)
check('...coded UNAUTHENTICATED', u.body.code === 'UNAUTHENTICATED', u.body.code)

u = await postUser({ userId: 'usr_1' }, { token: 'not-a-real-jwt' })
check('a garbage token -> 401', u.status === 401, u.status)

// Same spoofing check as POST /api/catches: signed in as usr_verified,
// claiming usr_spoofed in the body.
u = await postUser(
  { userId: 'usr_spoofed', displayName: 'Impersonator' },
  { token: signTestToken('usr_verified') },
)
check('the row is written under the token\'s userId', u.body.userId === 'usr_verified', u.body.userId)
check('...not the body\'s claimed userId', u.body.userId !== 'usr_spoofed', u.body.userId)
check('...and the spoofed id never got a row', storedUser('usr_spoofed') === undefined,
  JSON.stringify(usersTable))

const savedUsersClerkSecretKey = process.env.CLERK_SECRET_KEY
delete process.env.CLERK_SECRET_KEY
u = await postUser({ userId: 'usr_1' })
check('Clerk unconfigured -> 503, not a crash', u.status === 503, u.status)
check('...coded AUTH_NOT_CONFIGURED', u.body.code === 'AUTH_NOT_CONFIGURED', u.body.code)
process.env.CLERK_SECRET_KEY = savedUsersClerkSecretKey

console.log('\n-- get a user with no row and no catches --')
resetTable()

let g = await getUser('usr_nobody')
check('unknown user -> 200, not 404', g.status === 200, g.status)
check('the userId is echoed back', g.body.userId === 'usr_nobody', g.body.userId)
check('displayName is null, not invented', g.body.displayName === null, g.body.displayName)
check('totalPoints is 0', g.body.totalPoints === 0, g.body.totalPoints)
check('catchCount is 0', g.body.catchCount === 0, g.body.catchCount)
check('uniqueSpeciesCount is 0', g.body.uniqueSpeciesCount === 0, g.body.uniqueSpeciesCount)
check('currentStreakDays is 0 with no sightings ever', g.body.currentStreakDays === 0,
  g.body.currentStreakDays)
check('streakMultiplier is 1 at zero streak', g.body.streakMultiplier === 1, g.body.streakMultiplier)
check('reading does not create a row', usersTable.length === 0, usersTable.length)

console.log('\n-- get a user, aggregated over their catches --')
resetTable()

await postUser({ userId: 'usr_p', displayName: 'Point Getter' })

// catchCount/uniqueSpeciesCount still come from `catches`: 4 rows, 3 distinct
// taxa. The fourth row is a species already caught, in another place: a real
// observation, worth points, but not a new catalogue entry.
seed('usr_p', 126887, 'catch')
seed('usr_p', 48472, 'catch')
seed('usr_p', 61317, 'threat_report')
seed('usr_p', 126887, 'catch', 962)
seed('usr_other', 58732, 'threat_report') // must not leak into usr_p's totals

// totalPoints now sums `sightings.points_awarded`, not a flat rate off
// `catches` — 20 + 20 + 50 + 1 = 91. The last one stands in for the repeat
// sighting that produced the fourth `catches` row above (a token amount,
// same as a same-day repeat_extra would score).
seedSighting('usr_p', 126887, 'catch', 20)
seedSighting('usr_p', 48472, 'catch', 20)
seedSighting('usr_p', 61317, 'threat_report', 50)
seedSighting('usr_p', 126887, 'catch', 1)
seedSighting('usr_other', 58732, 'threat_report', 50) // must not leak into usr_p's totals

g = await getUser('usr_p')
check('displayName comes from the users row', g.body.displayName === 'Point Getter',
  g.body.displayName)
check('totalPoints sums this user\'s sightings', g.body.totalPoints === 91, g.body.totalPoints)
check('catchCount counts every row', g.body.catchCount === 4, g.body.catchCount)
check('uniqueSpeciesCount counts distinct taxa', g.body.uniqueSpeciesCount === 3,
  g.body.uniqueSpeciesCount)

g = await getUser('usr_other')
check('aggregates are per user', g.body.totalPoints === 50, g.body.totalPoints)
check('...and one row is one catch', g.body.catchCount === 1, g.body.catchCount)
check('...with no name until they upsert', g.body.displayName === null, g.body.displayName)

// There is no foreign key from catches.user_id to users.user_id (migration
// 003 says why), so catches recorded before this table existed still count.
console.log('\n-- catches with no users row still aggregate --')
resetTable()
seed('usr_legacy', 126887, 'catch')
seed('usr_legacy', 61317, 'threat_report')
seedSighting('usr_legacy', 126887, 'catch', 20)
seedSighting('usr_legacy', 61317, 'threat_report', 50)

g = await getUser('usr_legacy')
check('points are counted without a users row', g.body.totalPoints === 70, g.body.totalPoints)
check('counts are too', g.body.catchCount === 2 && g.body.uniqueSpeciesCount === 2,
  `${g.body.catchCount} ${g.body.uniqueSpeciesCount}`)
check('displayName stays null', g.body.displayName === null, g.body.displayName)

// ...and the reverse: naming yourself does not invent catches.
await postUser({ userId: 'usr_named_only', displayName: 'Just Arrived' })
g = await getUser('usr_named_only')
check('a named user with no catches reports zeros',
  g.body.totalPoints === 0 && g.body.catchCount === 0 && g.body.uniqueSpeciesCount === 0,
  JSON.stringify(g.body))
check('...but still reports their name', g.body.displayName === 'Just Arrived', g.body.displayName)

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------

const getLeaderboard = async () => {
  const res = await realFetch(`${base}/api/leaderboard`)
  return { status: res.status, body: await res.json() }
}

console.log('\n-- leaderboard, empty --')
resetTable()

let lb = await getLeaderboard()
check('empty leaderboard -> 200', lb.status === 200, lb.status)
check('...with an empty array', Array.isArray(lb.body) && lb.body.length === 0,
  JSON.stringify(lb.body))

console.log('\n-- leaderboard, ranked by points --')
resetTable()

await postUser({ userId: 'usr_a', displayName: 'Fern Gully' })
await postUser({ userId: 'usr_b', displayName: 'Mossy Log' })

seed('usr_a', 126887, 'catch')
seed('usr_a', 48472, 'catch')
seed('usr_b', 61317, 'threat_report')
seedSighting('usr_a', 126887, 'catch', 20)
seedSighting('usr_a', 48472, 'catch', 20)
seedSighting('usr_b', 61317, 'threat_report', 50)

lb = await getLeaderboard()
check('the higher scorer ranks first', lb.body[0].userId === 'usr_b', JSON.stringify(lb.body))
check('...with the summed points', lb.body[0].totalPoints === 50, lb.body[0].totalPoints)
check('the second scorer follows', lb.body[1].userId === 'usr_a', JSON.stringify(lb.body))
check('...with points from both sightings', lb.body[1].totalPoints === 40, lb.body[1].totalPoints)
check('uniqueSpeciesCount reflects distinct taxa', lb.body[1].uniqueSpeciesCount === 2,
  lb.body[1].uniqueSpeciesCount)
check('displayName resolved from the users table', lb.body[0].displayName === 'Mossy Log',
  lb.body[0].displayName)

console.log('\n-- leaderboard: a user with no sightings or catches does not appear --')
await postUser({ userId: 'usr_idle', displayName: 'Idle Explorer' })
lb = await getLeaderboard()
check('idle user is absent', !lb.body.some((row) => row.userId === 'usr_idle'),
  JSON.stringify(lb.body))

// ---------------------------------------------------------------------------
// GET /api/users/:userId/achievements — native and invasive badge state.
// ---------------------------------------------------------------------------

const getAchievements = async (userId) => {
  const res = await realFetch(`${base}/api/users/${encodeURIComponent(userId)}/achievements`)
  return { status: res.status, body: await res.json() }
}

// This route never looks a taxon up against iNaturalist — it only reads
// taxon_id and type back out of `catches` — so a synthetic id not present in
// TAXA is fine, unlike seed()/seedRow() above which both dereference TAXA.
const seedAchievementRow = (user_id, taxon_id, type, place_id = 10) =>
  table.push({
    id: `row_${nextId++}`,
    user_id,
    taxon_id,
    type,
    place_id,
    common_name: `Species ${taxon_id}`,
    scientific_name: `Species ${taxon_id}`,
    created_at: new Date().toISOString(),
  })

console.log('\n-- achievements: no catches --')
resetTable()

let a = await getAchievements('usr_nobody')
check('unknown user -> 200, not 404', a.status === 200, a.status)
check('nativeSpeciesCount is 0', a.body.nativeSpeciesCount === 0, a.body.nativeSpeciesCount)
check('invasiveSpeciesCount is 0', a.body.invasiveSpeciesCount === 0, a.body.invasiveSpeciesCount)
check('all 7 native badges present', a.body.nativeBadges.length === 7, a.body.nativeBadges.length)
check('all 4 invasive badges present', a.body.invasiveBadges.length === 4,
  a.body.invasiveBadges.length)
check('every native badge starts locked', a.body.nativeBadges.every((b) => b.unlocked === false))
check('every invasive badge starts locked',
  a.body.invasiveBadges.every((b) => b.unlocked === false))
check('native thresholds match the real scheme',
  JSON.stringify(a.body.nativeBadges.map((b) => b.threshold)) ===
    JSON.stringify([1, 5, 10, 25, 50, 75, 100]),
  JSON.stringify(a.body.nativeBadges.map((b) => b.threshold)))
check('invasive thresholds match the real scheme',
  JSON.stringify(a.body.invasiveBadges.map((b) => b.threshold)) === JSON.stringify([1, 5, 10, 25]),
  JSON.stringify(a.body.invasiveBadges.map((b) => b.threshold)))
check('badge labels match the named scheme',
  a.body.nativeBadges[0].label === 'First Seed' &&
    a.body.nativeBadges[6].label === 'Keeper of the Garden' &&
    a.body.invasiveBadges[0].label === 'First Watch' &&
    a.body.invasiveBadges[3].label === 'Guardian of the Grove',
  JSON.stringify([a.body.nativeBadges, a.body.invasiveBadges]))

console.log('\n-- achievements: species counted distinctly, not raw catches --')
resetTable()

// Same species logged in two places is one entry toward the count, matching
// GET /api/users/:userId's uniqueSpeciesCount.
seedAchievementRow('usr_dup', 5001, 'catch', 10)
seedAchievementRow('usr_dup', 5001, 'catch', 962)
seedAchievementRow('usr_dup', 5002, 'threat_report', 10)
seedAchievementRow('usr_dup', 5002, 'threat_report', 962)

a = await getAchievements('usr_dup')
check('duplicate species across places counts once (native)',
  a.body.nativeSpeciesCount === 1, a.body.nativeSpeciesCount)
check('duplicate species across places counts once (invasive)',
  a.body.invasiveSpeciesCount === 1, a.body.invasiveSpeciesCount)

console.log('\n-- achievements: native and invasive counted independently --')
resetTable()

seedAchievementRow('usr_split', 5010, 'catch')
seedAchievementRow('usr_split', 5011, 'catch')
seedAchievementRow('usr_split', 5012, 'catch')

a = await getAchievements('usr_split')
check('an all-native user has invasiveSpeciesCount 0', a.body.invasiveSpeciesCount === 0,
  a.body.invasiveSpeciesCount)
check('...and every invasive badge stays locked',
  a.body.invasiveBadges.every((b) => b.unlocked === false))
check('nativeSpeciesCount reflects the 3 species', a.body.nativeSpeciesCount === 3,
  a.body.nativeSpeciesCount)

console.log('\n-- achievements: native threshold boundaries --')
resetTable()

for (let i = 0; i < 4; i++) seedAchievementRow('usr_boundary', 6000 + i, 'catch')
a = await getAchievements('usr_boundary')
check('4 species: First Seed (1) unlocked, Tender Sprout (5) not yet',
  a.body.nativeBadges[0].unlocked === true && a.body.nativeBadges[1].unlocked === false,
  JSON.stringify(a.body.nativeBadges))

seedAchievementRow('usr_boundary', 6004, 'catch') // 5th species
a = await getAchievements('usr_boundary')
check('exactly 5 species unlocks Tender Sprout', a.body.nativeBadges[1].unlocked === true,
  JSON.stringify(a.body.nativeBadges))
check('...but not Budding Grace (threshold 10)', a.body.nativeBadges[2].unlocked === false,
  JSON.stringify(a.body.nativeBadges))

for (let i = 5; i < 9; i++) seedAchievementRow('usr_boundary', 6000 + i, 'catch') // 9 total
a = await getAchievements('usr_boundary')
check('9 species: one short of Budding Grace stays locked',
  a.body.nativeBadges[2].unlocked === false, a.body.nativeSpeciesCount)

seedAchievementRow('usr_boundary', 6009, 'catch') // 10th species
a = await getAchievements('usr_boundary')
check('exactly 10 species unlocks Budding Grace', a.body.nativeBadges[2].unlocked === true,
  a.body.nativeSpeciesCount)

for (let i = 10; i < 100; i++) seedAchievementRow('usr_boundary', 6000 + i, 'catch') // 100 total
a = await getAchievements('usr_boundary')
check('exactly 100 species unlocks every native badge',
  a.body.nativeBadges.every((b) => b.unlocked === true), a.body.nativeSpeciesCount)
check('nativeSpeciesCount is exactly 100', a.body.nativeSpeciesCount === 100,
  a.body.nativeSpeciesCount)

console.log('\n-- achievements: invasive threshold boundaries --')
resetTable()

for (let i = 0; i < 24; i++) seedAchievementRow('usr_threat', 7000 + i, 'threat_report')
a = await getAchievements('usr_threat')
check('24 invasive species: Guardian of the Grove (25) still locked',
  a.body.invasiveBadges[3].unlocked === false, a.body.invasiveSpeciesCount)
check('...but Warden of the Wild (10) is already unlocked',
  a.body.invasiveBadges[2].unlocked === true, a.body.invasiveSpeciesCount)

seedAchievementRow('usr_threat', 7024, 'threat_report') // 25th
a = await getAchievements('usr_threat')
check('exactly 25 invasive species unlocks Guardian of the Grove',
  a.body.invasiveBadges[3].unlocked === true, a.body.invasiveSpeciesCount)
check('every invasive badge is unlocked at 25',
  a.body.invasiveBadges.every((b) => b.unlocked === true), a.body.invasiveSpeciesCount)

console.log('\n-- achievements: validation --')
a = await getAchievements('  ')
check('whitespace-only userId -> 400', a.status === 400, a.status)
check('...coded BAD_REQUEST', a.body.code === 'BAD_REQUEST', a.body.code)

console.log(`\n${pass} passed, ${fail} failed\n`)
server.close()
process.exit(fail === 0 ? 0 : 1)
