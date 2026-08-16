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
  // No establishment_means and no listed_taxa: iNaturalist has no checklist
  // entry for this taxon here. classify() files it as a 'catch' (a species we
  // cannot classify is not evidence of a threat), which is exactly the case
  // that must NOT be counted as a native species.
  42220: {
    id: 42220,
    name: 'Odocoileus hemionus',
    preferred_common_name: 'Mule Deer',
    rank: 'species',
    observations_count: 15640,
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

// Stands in for public.users (migration 003). Separate array, no foreign key
// between them — same as the real schema, which is what lets GET /api/users
// aggregate catches for a user that has no row here.
let usersTable = []

const resetTable = () => {
  table = []
  usersTable = []
  nextId = 1
}

/** The array backing a `/rest/v1/<name>` path, or undefined if unstubbed. */
const storeFor = (name) => (name === 'catches' ? table : name === 'users' ? usersTable : undefined)

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
  // /v1/taxa/:id  (one or more comma-separated ids)
  const detail = url.pathname.match(/^\/v1\/taxa\/([\d,]+)$/)
  if (detail) {
    if (failTaxaLookup) return json({ error: 'upstream is down' }, 500)
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
      ...(tableName === 'catches' ? { id: `row_${nextId++}` } : {}),
      created_at: new Date().toISOString(),
      ...row,
    }))

    // The unique index from migration 002 on catches, and the primary key on
    // users — both enforced here so the race paths are reachable in a test.
    for (const row of rows) {
      const clash =
        tableName === 'users'
          ? store.find((existing) => existing.user_id === row.user_id)
          : store.find(
              (existing) =>
                existing.user_id === row.user_id &&
                Number(existing.taxon_id) === Number(row.taxon_id) &&
                Number(existing.place_id) === Number(row.place_id),
            )
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

const listCatches = async (query = '') => {
  const res = await realFetch(`${base}/api/catches${query}`)
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
// GET /api/catches — the list endpoint behind the map and the dex.
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
check('placeName resolved for the filtered place', l.body.placeName === 'Oregon', l.body.placeName)

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
  'created_at']) {
  check(`row carries ${field}`, field in row, JSON.stringify(row))
}
check('row does not leak user_id', !('user_id' in row), JSON.stringify(row))
check('row does not leak photo_url', !('photo_url' in row))

// The map filters these out client-side; the endpoint must not do it for it,
// or the dex silently loses every catch logged without geolocation.
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

const postUser = async (body) => {
  const res = await realFetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
u = await postUser({})
check('missing userId -> 400', u.status === 400, u.status)
check('...coded BAD_REQUEST', u.body.code === 'BAD_REQUEST', u.body.code)
u = await postUser({ userId: '   ' })
check('whitespace-only userId -> 400', u.status === 400, u.status)
u = await postUser({ userId: 'usr_1', displayName: 'x'.repeat(61) })
check('over-long displayName -> 400', u.status === 400, u.status)
check('...and the stored name survives the rejection',
  storedUser('usr_1').display_name === 'Trailing Space', storedUser('usr_1').display_name)
u = await postUser({ userId: 'usr_1', displayName: 'x'.repeat(60) })
check('exactly at the limit is accepted', u.status === 200, u.status)

console.log('\n-- get a user with no row and no catches --')
resetTable()

let g = await getUser('usr_nobody')
check('unknown user -> 200, not 404', g.status === 200, g.status)
check('the userId is echoed back', g.body.userId === 'usr_nobody', g.body.userId)
check('displayName is null, not invented', g.body.displayName === null, g.body.displayName)
check('totalPoints is 0', g.body.totalPoints === 0, g.body.totalPoints)
check('catchCount is 0', g.body.catchCount === 0, g.body.catchCount)
check('uniqueSpeciesCount is 0', g.body.uniqueSpeciesCount === 0, g.body.uniqueSpeciesCount)
check('reading does not create a row', usersTable.length === 0, usersTable.length)

console.log('\n-- get a user, aggregated over their catches --')
resetTable()

await postUser({ userId: 'usr_p', displayName: 'Point Getter' })

// 10 + 10 + 25 + 10 = 55 points across 4 rows and 3 distinct taxa. The fourth
// row is a species already caught, in another place: a real observation, worth
// points, but not a new dex entry.
seed('usr_p', 126887, 'catch')
seed('usr_p', 48472, 'catch')
seed('usr_p', 61317, 'threat_report')
seed('usr_p', 126887, 'catch', 962)
seed('usr_other', 58732, 'threat_report') // must not leak into usr_p's totals

g = await getUser('usr_p')
check('displayName comes from the users row', g.body.displayName === 'Point Getter',
  g.body.displayName)
check('totalPoints weights threat reports higher', g.body.totalPoints === 55, g.body.totalPoints)
check('catchCount counts every row', g.body.catchCount === 4, g.body.catchCount)
check('uniqueSpeciesCount counts distinct taxa', g.body.uniqueSpeciesCount === 3,
  g.body.uniqueSpeciesCount)

g = await getUser('usr_other')
check('aggregates are per user', g.body.totalPoints === 25, g.body.totalPoints)
check('...and one row is one catch', g.body.catchCount === 1, g.body.catchCount)
check('...with no name until they upsert', g.body.displayName === null, g.body.displayName)

// There is no foreign key from catches.user_id to users.user_id (migration
// 003 says why), so catches recorded before this table existed still count.
console.log('\n-- catches with no users row still aggregate --')
resetTable()
seed('usr_legacy', 126887, 'catch')
seed('usr_legacy', 61317, 'threat_report')

g = await getUser('usr_legacy')
check('points are counted without a users row', g.body.totalPoints === 35, g.body.totalPoints)
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

console.log(`\n${pass} passed, ${fail} failed\n`)
server.close()
process.exit(fail === 0 ? 0 : 1)
