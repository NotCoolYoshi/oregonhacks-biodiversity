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

const realFetch = globalThis.fetch

const express = (await import('express')).default
const { default: router } = await import('../src/routes/api.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Keyed by iNaturalist taxon id. Establishment means is what the route uses to
// decide catch vs threat_report, so each id here is a fixed verdict.
const TAXA = {
  126887: {
    id: 126887,
    name: 'Berberis aquifolium',
    preferred_common_name: 'Oregon grape',
    rank: 'species',
    observations_count: 68775,
    establishment_means: { establishment_means: 'native', place: { id: 10 } },
  },
  61317: {
    id: 61317,
    name: 'Rubus armeniacus',
    preferred_common_name: 'Armenian Blackberry',
    rank: 'species',
    observations_count: 40000,
    establishment_means: { establishment_means: 'introduced', place: { id: 10 } },
  },
  48472: {
    id: 48472,
    name: 'Pseudotsuga menziesii',
    preferred_common_name: 'Douglas-fir',
    rank: 'species',
    observations_count: 11078,
    establishment_means: { establishment_means: 'native', place: { id: 10 } },
  },
  58732: {
    id: 58732,
    name: 'Cytisus scoparius',
    preferred_common_name: 'Scotch broom',
    rank: 'species',
    observations_count: 942,
    establishment_means: { establishment_means: 'invasive', place: { id: 10 } },
  },
}

const NAME_TO_ID = Object.fromEntries(
  Object.values(TAXA).map((taxon) => [taxon.name.toLowerCase(), taxon.id]),
)

// Stands in for public.catches.
let table = []
let nextId = 1
const resetTable = () => {
  table = []
  nextId = 1
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// ---------------------------------------------------------------------------
// Upstream stubs
// ---------------------------------------------------------------------------

function handleINaturalist(url) {
  // /v1/taxa/:id  (one or more comma-separated ids)
  const detail = url.pathname.match(/^\/v1\/taxa\/([\d,]+)$/)
  if (detail) {
    const ids = detail[1].split(',').map(Number)
    const results = ids.map((id) => TAXA[id]).filter(Boolean)
    return json({ total_results: results.length, results })
  }

  // /v1/taxa?q=<scientific name>
  if (url.pathname === '/v1/taxa') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const id = NAME_TO_ID[q]
    return json({ total_results: id ? 1 : 0, results: id ? [TAXA[id]] : [] })
  }

  return json({ error: `unstubbed iNaturalist path ${url.pathname}` }, 404)
}

/**
 * A very small slice of PostgREST: `col=eq.value` filters, `limit`, and
 * `Prefer: return=representation` on insert. That is everything the two routes
 * under test actually use.
 */
async function handlePostgrest(url, init) {
  if (!url.pathname.startsWith('/rest/v1/catches')) {
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
      id: `row_${nextId++}`,
      created_at: new Date().toISOString(),
      ...row,
    }))

    // The unique index from migration 002, enforced here so the race path is
    // reachable in a test.
    for (const row of rows) {
      const clash = table.find(
        (existing) =>
          existing.user_id === row.user_id &&
          Number(existing.taxon_id) === Number(row.taxon_id) &&
          Number(existing.place_id) === Number(row.place_id),
      )
      if (clash) {
        return json(
          {
            code: '23505',
            message: 'duplicate key value violates unique constraint "catches_user_taxon_place_uniq"',
          },
          409,
        )
      }
      table.push(row)
    }

    return json(wantsObject ? rows[0] : rows, 201)
  }

  // GET — apply the eq filters, then the limit.
  let rows = [...table]
  for (const [key, value] of url.searchParams) {
    if (['select', 'limit', 'offset', 'order'].includes(key)) continue
    if (!value.startsWith('eq.')) continue
    const wanted = value.slice(3)
    rows = rows.filter((row) => String(row[key]) === wanted)
  }

  const limit = Number(url.searchParams.get('limit'))
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit)

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
  if (url.hostname.endsWith('supabase.co')) return handlePostgrest(url, init)

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

const post = async (body) => {
  const res = await realFetch(`${base}/api/catches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const getScore = async (placeId) => {
  const res = await realFetch(`${base}/api/region/${placeId}/score`)
  return { status: res.status, body: await res.json() }
}

const CATCH = { userId: 'usr_1', placeId: 10, location: { lat: 44.05, lng: -123.08 } }

// ---------------------------------------------------------------------------

console.log('\n-- type is decided server-side, not by the client --')
resetTable()

// Armenian blackberry is introduced. The client says it caught one.
let r = await post({ ...CATCH, taxonId: 61317, type: 'catch' })
check('invasive claimed as catch is stored as threat_report',
  r.status === 201 && r.body.type === 'threat_report', `${r.status} ${r.body.type}`)
check('override is reported via typeCorrected', r.body.typeCorrected === true)
check('override reports what was claimed', r.body.claimedType === 'catch', r.body.claimedType)
check('points follow the server type, not the claim', r.body.pointsAwarded === 25,
  r.body.pointsAwarded)
check('establishmentMeans surfaced', r.body.establishmentMeans === 'introduced',
  r.body.establishmentMeans)
check('persisted row carries the corrected type', table[0].type === 'threat_report',
  table[0].type)

// ...and the reverse: no farming the higher threat_report points off a native.
r = await post({ ...CATCH, taxonId: 126887, type: 'threat_report' })
check('native claimed as threat_report is stored as catch',
  r.status === 201 && r.body.type === 'catch', `${r.status} ${r.body.type}`)
check('points drop to the catch value', r.body.pointsAwarded === 10, r.body.pointsAwarded)
check('typeCorrected set on this direction too', r.body.typeCorrected === true)

r = await post({ ...CATCH, taxonId: 48472, type: 'catch' })
check('an honest claim is not flagged as corrected', r.body.typeCorrected === false)
check('claimedType omitted when nothing was corrected', !('claimedType' in r.body))

r = await post({ ...CATCH, taxonId: 58732 })
check('missing type still classified from iNaturalist',
  r.body.type === 'threat_report' && r.body.typeCorrected === false, r.body.type)

console.log('\n-- isFirstCatch --')
resetTable()

r = await post({ ...CATCH, taxonId: 126887 })
check('first ever sighting is a first catch', r.body.isFirstCatch === true)

// Same species, different place: a real observation, but not a new dex entry.
r = await post({ ...CATCH, taxonId: 126887, placeId: 962 })
check('same species in a new place still records', r.status === 201, r.status)
check('...but is not a first catch', r.body.isFirstCatch === false)

r = await post({ ...CATCH, taxonId: 61317 })
check('a different species is a first catch again', r.body.isFirstCatch === true)

r = await post({ ...CATCH, userId: 'usr_2', taxonId: 126887 })
check('first catch is per user, not global', r.body.isFirstCatch === true)

console.log('\n-- duplicate suppression --')
resetTable()

await post({ ...CATCH, taxonId: 61317 })
const before = table.length
r = await post({ ...CATCH, taxonId: 61317 })
check('same user + taxon + place is rejected', r.status === 409, r.status)
check('rejection is coded DUPLICATE_CATCH', r.body.code === 'DUPLICATE_CATCH', r.body.code)
check('rejection points at the existing row', Boolean(r.body.existingCatchId))
check('no second row was written', table.length === before, `${table.length} vs ${before}`)

console.log('\n-- request validation --')
r = await post({ taxonId: 126887 })
check('missing userId -> 400', r.status === 400, r.status)
r = await post({ userId: 'usr_1' })
check('missing taxonId and scientificName -> 400', r.status === 400, r.status)

resetTable()
r = await post({ ...CATCH, scientificName: 'Rubus armeniacus' })
check('scientificName resolves to a taxon id', r.body.taxonId === 61317, r.body.taxonId)
check('resolved species is still classified server-side', r.body.type === 'threat_report')

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

console.log('\n-- region score, no data --')
resetTable()
r = await getScore(10)
check('empty region scores 0', r.body.score === 0, r.body.score)
check('empty region grades N/A rather than F', r.body.grade === 'N/A', r.body.grade)
check('empty region reports zero totals',
  r.body.totals.catches === 0 && r.body.totals.contributors === 0)
check('empty region has no top threats', r.body.topThreats.length === 0)
check('empty region trend is flat', r.body.trend.direction === 'flat', r.body.trend.direction)

r = await getScore('not-a-place')
check('non-numeric placeId -> 400', r.status === 400, r.status)

console.log(`\n${pass} passed, ${fail} failed\n`)
server.close()
process.exit(fail === 0 ? 0 : 1)
