// Checks that every failure code the server can return gets its own guidance,
// rather than falling through to the generic branch.
//
// The point is not that the copy is nice, it is that the branches are
// *distinct and correct*: a user out of quota must not be told to retry, and a
// bad server key must not be blamed on their photo. Those are the two ways
// this mapping fails silently, so both are asserted directly.

import {
  describeIdentifyError,
  describeSubmitError,
  describeRetriesExhausted,
} from '../src/errors.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

/** Shaped like an axios error for a JSON error response. */
const axiosError = (status, body) => ({ response: { status, data: body } })

// Every code server/src/services/plantnet.js can throw, plus the transport
// failures that never reach it.
const IDENTIFY_CODES = [
  'PLANTNET_AUTH',
  'QUOTA_EXCEEDED',
  'NO_MATCH',
  'LOW_CONFIDENCE',
  'IMAGE_TOO_LARGE',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_UNREACHABLE',
  'BAD_IMAGE',
  'BAD_REQUEST',
]

console.log('\n-- every identify code is handled distinctly --')

const generic = describeIdentifyError(axiosError(500, { code: 'SOMETHING_NEW' }), 'leaf')
const titles = new Map()

for (const code of IDENTIFY_CODES) {
  const described = describeIdentifyError(axiosError(400, { code, error: 'detail from server' }), 'leaf')
  check(`${code} does not fall through to the generic branch`,
    described.title !== generic.title, `got "${described.title}"`)
  check(`${code} has actionable guidance`,
    typeof described.guidance === 'string' && described.guidance.length > 20)
  titles.set(code, described.title)
}

// Two pairs deliberately share copy, because the distinction inside each pair
// is ours and not the user's:
//   UPSTREAM_UNAVAILABLE / UPSTREAM_UNREACHABLE -> "Pl@ntNet is down"
//   BAD_IMAGE / BAD_REQUEST                     -> "that file isn't an image"
// Every other code stands alone. If a future code joins one of these buckets
// by accident, this count drops and the test says so.
const uniqueTitles = new Set(titles.values())
check('each code maps to its own message, bar two deliberately shared pairs',
  uniqueTitles.size === IDENTIFY_CODES.length - 2,
  `${uniqueTitles.size} unique titles from ${IDENTIFY_CODES.length} codes`)

console.log('\n-- retry advice matches what the user can actually do --')

check('quota exhaustion does not offer a retry',
  describeIdentifyError(axiosError(429, { code: 'QUOTA_EXCEEDED' }), 'leaf').canRetry === false)
check('quota message says it resets rather than suggesting a retry',
  /tomorrow/i.test(describeIdentifyError(axiosError(429, { code: 'QUOTA_EXCEEDED' }), 'leaf').guidance))
check('a bad server key does not offer a retry',
  describeIdentifyError(axiosError(500, { code: 'PLANTNET_AUTH' }), 'leaf').canRetry === false)
check('a bad server key does not blame the photo',
  /nothing is wrong with your photo/i.test(
    describeIdentifyError(axiosError(500, { code: 'PLANTNET_AUTH' }), 'leaf').guidance))
check('a timeout does offer a retry',
  describeIdentifyError(axiosError(504, { code: 'UPSTREAM_TIMEOUT' }), 'leaf').canRetry === true)

console.log('\n-- low confidence adapts to the organ that was photographed --')

const leafAdvice = describeIdentifyError(axiosError(404, { code: 'LOW_CONFIDENCE' }), 'leaf')
const flowerAdvice = describeIdentifyError(axiosError(404, { code: 'LOW_CONFIDENCE' }), 'flower')
check('a weak organ is told to try flower or fruit', /flower or\s+fruit/i.test(leafAdvice.guidance),
  leafAdvice.guidance)
check('bark gets the same upgrade advice as leaf',
  describeIdentifyError(axiosError(404, { code: 'LOW_CONFIDENCE' }), 'bark').guidance ===
    leafAdvice.guidance)
check('a flower photo is not told to photograph the flower',
  !/flower or\s+fruit/i.test(flowerAdvice.guidance), flowerAdvice.guidance)
check('detail is null, not undefined, when the server sent none',
  leafAdvice.detail === null, String(leafAdvice.detail))
check('low confidence keeps the closest-guess detail from the server',
  describeIdentifyError(
    axiosError(404, { code: 'LOW_CONFIDENCE', error: 'Closest guess was Berberis sibirica at 7%' }),
    'leaf',
  ).detail === 'Closest guess was Berberis sibirica at 7%')

console.log('\n-- transport and body-size failures --')

check('no response at all reads as a network problem',
  describeIdentifyError(new Error('Network Error'), 'leaf').code === 'NETWORK')
check('network guidance mentions the server being down',
  /server/i.test(describeIdentifyError(new Error('Network Error'), 'leaf').guidance))
// Express rejects an oversized body before the route runs, so there is no code.
check('a bare 413 is still recognised as an oversized photo',
  describeIdentifyError(axiosError(413, ''), 'leaf').code === 'IMAGE_TOO_LARGE')

console.log('\n-- the retry ladder giving up --')

// Reached only when all five photos were rejected outright, so no candidate was
// ever returned to settle for. See handleWeakAttempt in views/PhotoCapture.jsx.
const exhaustedLeaf = describeRetriesExhausted('leaf', 5)
const exhaustedFlower = describeRetriesExhausted('flower', 5)

check('exhaustion says how many photos were tried',
  /5 photos/.test(exhaustedLeaf.title), exhaustedLeaf.title)
check('exhaustion is distinct from a single low-confidence result',
  exhaustedLeaf.title !== leafAdvice.title, exhaustedLeaf.title)
check('exhaustion still offers a fresh start', exhaustedLeaf.canRetry === true)
check('a weak organ is told to try flower or fruit here too',
  /flower or\s+fruit/i.test(exhaustedLeaf.guidance), exhaustedLeaf.guidance)
check('a flower photo is not told to photograph the flower',
  !/flower or\s+fruit/i.test(exhaustedFlower.guidance), exhaustedFlower.guidance)

console.log('\n-- catch submission failures --')

const duplicate = describeSubmitError(
  axiosError(409, { code: 'DUPLICATE_CATCH', error: 'You have already logged Rubus armeniacus in Oregon.' }),
)
check('a duplicate is named as such', duplicate.title === 'Already in your catalogue', duplicate.title)
check('a duplicate does not offer a pointless retry', duplicate.canRetry === false)
check("a duplicate shows the server's explanation",
  /already logged/i.test(duplicate.guidance), duplicate.guidance)

check('an unconfigured database is distinguished from a rejected catch',
  describeSubmitError(axiosError(503, { code: 'DB_NOT_CONFIGURED' })).title !==
    describeSubmitError(axiosError(500, {})).title)
check('an unknown taxon is distinguished too',
  describeSubmitError(axiosError(404, { code: 'TAXON_NOT_FOUND' })).title !==
    describeSubmitError(axiosError(500, {})).title)
check('an unrecognised submit failure still offers a retry',
  describeSubmitError(axiosError(500, {})).canRetry === true)

console.log('\n-- auth failures on submit --')

const unauthenticated = describeSubmitError(axiosError(401, { code: 'UNAUTHENTICATED', error: 'Sign in required.' }))
check('an unauthenticated submit is named as such',
  unauthenticated.title === 'Sign in to log this catch', unauthenticated.title)
check('an unauthenticated submit does not offer a pointless retry',
  unauthenticated.canRetry === false)
check('an unauthenticated submit tells the user to sign in',
  /sign in/i.test(unauthenticated.guidance), unauthenticated.guidance)

const authNotConfigured = describeSubmitError(axiosError(503, { code: 'AUTH_NOT_CONFIGURED' }))
check('a missing Clerk config is distinguished from "not signed in"',
  authNotConfigured.title !== unauthenticated.title, authNotConfigured.title)
check('a missing Clerk config does not blame the photo',
  /nothing is wrong with your photo/i.test(authNotConfigured.guidance), authNotConfigured.guidance)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
