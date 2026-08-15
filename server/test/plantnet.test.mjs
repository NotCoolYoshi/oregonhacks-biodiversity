// Exercises the real Pl@ntNet code path with a stubbed fetch, so the mapping and
// error branches are verified without burning quota or needing a key.
//
// Run with `npm test` from server/. No network, no API key, no fixtures on disk.
//
// The imports are dynamic and come after the env var is set: plantnet.js reads
// PLANTNET_API_KEY at call time rather than import time, but keeping the order
// explicit means this still holds if that ever changes.
process.env.PLANTNET_API_KEY = 'test-key'

const { identifyPlant, PlantNetError } = await import('../src/services/plantnet.js')
const { IDENTIFY_RESULT } = await import('../src/mocks.js')

// Trimmed from a real Pl@ntNet v2 /identify/all response.
const PLANTNET_PAYLOAD = {
  query: { project: 'all', images: ['x'], organs: ['leaf'] },
  language: 'en',
  bestMatch: 'Mahonia aquifolium (Pursh) Nutt.',
  results: [
    {
      score: 0.87341234,
      species: {
        scientificNameWithoutAuthor: 'Mahonia aquifolium',
        scientificNameAuthorship: '(Pursh) Nutt.',
        genus: { scientificNameWithoutAuthor: 'Mahonia' },
        family: { scientificNameWithoutAuthor: 'Berberidaceae' },
        commonNames: ['Oregon grape', 'Holly-leaved barberry'],
        scientificName: 'Mahonia aquifolium (Pursh) Nutt.',
      },
      images: [{ url: { o: 'https://o.jpg', m: 'https://m.jpg', s: 'https://s.jpg' } }],
      gbif: { id: 3033824 },
    },
    {
      score: 0.0912,
      species: {
        scientificNameWithoutAuthor: 'Mahonia nervosa',
        genus: { scientificNameWithoutAuthor: 'Mahonia' },
        family: { scientificNameWithoutAuthor: 'Berberidaceae' },
        commonNames: ['Cascade barberry'],
      },
      images: [],
      gbif: { id: 3033841 },
    },
  ],
  remainingIdentificationRequests: 487,
}

const stub = (status, body, headers = {}) => {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}
const expectError = async (name, code, status, fn) => {
  try { await fn(); check(name, false, '(no error thrown)') }
  catch (e) {
    check(name, e instanceof PlantNetError && e.code === code && e.status === status,
      `got ${e.code}/${e.status} — ${e.message}`)
  }
}

const B64 = Buffer.from('fake-jpeg-bytes').toString('base64')

console.log('\n-- happy path --')
stub(200, PLANTNET_PAYLOAD)
const out = await identifyPlant({ imageBase64: B64, organs: ['leaf'] })

const mockKeys = Object.keys(IDENTIFY_RESULT).sort()
const realKeys = Object.keys(out).filter((k) => mockKeys.includes(k)).sort()
check('top-level shape covers every mock key', JSON.stringify(mockKeys) === JSON.stringify(realKeys),
  `mock=${mockKeys} real=${realKeys}`)

const mockResultKeys = Object.keys(IDENTIFY_RESULT.results[0]).sort()
const realResultKeys = Object.keys(out.results[0]).sort()
check('result item keys match mock exactly',
  JSON.stringify(mockResultKeys) === JSON.stringify(realResultKeys),
  `\n       mock=${mockResultKeys}\n       real=${realResultKeys}`)

check('bestMatch strips authorship', out.bestMatch === 'Mahonia aquifolium', out.bestMatch)
check('score rounded to 4dp', out.results[0].score === 0.8734, out.results[0].score)
check('genus mapped', out.results[0].genus === 'Mahonia')
check('family mapped', out.results[0].family === 'Berberidaceae')
check('commonNames mapped', out.results[0].commonNames[0] === 'Oregon grape')
check('gbifId stringified', out.results[0].gbifId === '3033824', out.results[0].gbifId)
check('inatTaxonId present but null', 'inatTaxonId' in out.results[0] && out.results[0].inatTaxonId === null)
check('imageUrl prefers medium', out.results[0].imageUrl === 'https://m.jpg')
check('empty images -> null imageUrl', out.results[1].imageUrl === null)
check('source=plantnet', out.source === 'plantnet')
check('remainingRequests surfaced', out.remainingRequests === 487)
check('organs defaulted into query', out.query.organs[0] === 'leaf')

console.log('\n-- organ handling --')
stub(200, PLANTNET_PAYLOAD)
check('invalid organ falls back to auto',
  (await identifyPlant({ imageBase64: B64, organs: ['spleen'] })).query.organs[0] === 'auto')
stub(200, PLANTNET_PAYLOAD)
check('missing organ defaults to auto',
  (await identifyPlant({ imageBase64: B64 })).query.organs[0] === 'auto')

console.log('\n-- error branches --')
stub(401, { message: 'Invalid api key' })
await expectError('401 -> PLANTNET_AUTH/500', 'PLANTNET_AUTH', 500, () => identifyPlant({ imageBase64: B64 }))

stub(429, { message: 'quota' }, { 'retry-after': '3600' })
await expectError('429 -> QUOTA_EXCEEDED/429', 'QUOTA_EXCEEDED', 429, () => identifyPlant({ imageBase64: B64 }))

stub(404, { message: 'Species not found' })
await expectError('404 -> NO_MATCH/404', 'NO_MATCH', 404, () => identifyPlant({ imageBase64: B64 }))

stub(413, {})
await expectError('413 -> IMAGE_TOO_LARGE/413', 'IMAGE_TOO_LARGE', 413, () => identifyPlant({ imageBase64: B64 }))

stub(500, { message: 'boom' })
await expectError('500 -> UPSTREAM_UNAVAILABLE/502', 'UPSTREAM_UNAVAILABLE', 502, () => identifyPlant({ imageBase64: B64 }))

stub(200, { ...PLANTNET_PAYLOAD, results: [] })
await expectError('empty results -> NO_MATCH/404', 'NO_MATCH', 404, () => identifyPlant({ imageBase64: B64 }))

stub(200, { ...PLANTNET_PAYLOAD, results: [{ ...PLANTNET_PAYLOAD.results[0], score: 0.03 }] })
await expectError('weak score -> LOW_CONFIDENCE/404', 'LOW_CONFIDENCE', 404, () => identifyPlant({ imageBase64: B64 }))

globalThis.fetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }
await expectError('timeout -> UPSTREAM_TIMEOUT/504', 'UPSTREAM_TIMEOUT', 504, () => identifyPlant({ imageBase64: B64 }))

globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
await expectError('network error -> UPSTREAM_UNREACHABLE/502', 'UPSTREAM_UNREACHABLE', 502, () => identifyPlant({ imageBase64: B64 }))

stub(200, PLANTNET_PAYLOAD)
await expectError('undecodable base64 -> BAD_IMAGE/400', 'BAD_IMAGE', 400, () => identifyPlant({ imageBase64: '' }))

console.log('\n-- key gating --')
const saved = process.env.PLANTNET_API_KEY
process.env.PLANTNET_API_KEY = '   '
await expectError('blank key -> PLANTNET_AUTH/500', 'PLANTNET_AUTH', 500, () => identifyPlant({ imageBase64: B64 }))
process.env.PLANTNET_API_KEY = saved

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
