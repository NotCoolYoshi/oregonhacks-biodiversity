// User-facing copy for the failure modes of /api/identify and /api/catches.
//
// Split out of PhotoCapture so the branch-per-error-code mapping can be tested
// without rendering anything — see client/test/errors.test.mjs.
//
// The server hands back a `code` on every failure (PlantNetError in
// server/src/services/plantnet.js, and the route handlers for the rest).
// Collapsing those into one "something went wrong" would tell a user to retry
// when they are out of quota for the day, or blame their photo for our expired
// API key. Each branch therefore owns its own guidance, and `canRetry` decides
// whether a retry button is even offered.

// Organs where a poor result is likely the organ's fault, not the photo's.
const WEAK_ORGANS = new Set(['leaf', 'bark', 'habit'])

/**
 * Turn an /api/identify failure into guidance the user can act on.
 *
 * The server hands back a `code` for every branch (see PlantNetError in
 * server/src/services/plantnet.js); collapsing them into one "something went
 * wrong" would tell a user to retry when they are out of quota for the day,
 * or blame their photo for our expired API key.
 */
export function describeIdentifyError(err, organ) {
  const response = err?.response
  const data = response?.data ?? {}
  const detail = typeof data.error === 'string' ? data.error : null

  // Express rejects an oversized body before the route runs, so that one
  // arrives as a bare 413 with no code of ours on it.
  const code = data.code ?? (response?.status === 413 ? 'IMAGE_TOO_LARGE' : response ? 'UNKNOWN' : 'NETWORK')

  switch (code) {
    case 'PLANTNET_AUTH':
      return {
        code,
        title: 'Identification is not configured',
        guidance:
          'The server’s Pl@ntNet key was rejected. Nothing is wrong with your photo — ' +
          'whoever is running the server needs to check PLANTNET_API_KEY.',
        canRetry: false,
      }
    case 'QUOTA_EXCEEDED':
      return {
        code,
        title: 'Out of identifications for today',
        guidance:
          'The free Pl@ntNet tier allows 500 a day and they are gone. This resets tomorrow — ' +
          'retrying now will not help.',
        canRetry: false,
      }
    case 'NO_MATCH':
      return {
        code,
        title: 'No match found',
        guidance:
          'Pl@ntNet did not recognise anything in that photo. Fill more of the frame with a ' +
          'single plant and keep the background simple.',
        canRetry: true,
      }
    case 'LOW_CONFIDENCE':
      return {
        code,
        title: 'Not a confident match',
        guidance: WEAK_ORGANS.has(organ)
          ? 'Leaves and bark look alike across whole genera. If this plant has a flower or ' +
            'fruit on it, photograph that instead — it identifies far more reliably.'
          : 'Try again from closer in, with the subject sharp and centred.',
        detail,
        canRetry: true,
      }
    case 'IMAGE_TOO_LARGE':
      return {
        code,
        title: 'Photo is too large',
        guidance: 'That image is bigger than the server accepts. Try a smaller or lower-resolution photo.',
        canRetry: true,
      }
    case 'UPSTREAM_TIMEOUT':
      return {
        code,
        title: 'Pl@ntNet timed out',
        guidance: 'It did not respond in time. This one is usually worth a second try.',
        canRetry: true,
      }
    case 'UPSTREAM_UNAVAILABLE':
    case 'UPSTREAM_UNREACHABLE':
      return {
        code,
        title: 'Pl@ntNet is unavailable',
        guidance: 'Their API is not responding right now. Try again in a minute.',
        canRetry: true,
      }
    case 'BAD_IMAGE':
    case 'BAD_REQUEST':
      return {
        code,
        title: 'That file did not read as an image',
        guidance: 'Pick a JPEG or PNG photo and try again.',
        canRetry: true,
      }
    case 'NETWORK':
      return {
        code,
        title: 'Cannot reach the server',
        guidance:
          'The API did not respond. If you are running this locally, check the server is up ' +
          'on port 5001.',
        canRetry: true,
      }
    default:
      return {
        code,
        title: 'Identification failed',
        guidance: 'Something unexpected went wrong.',
        detail,
        canRetry: true,
      }
  }
}

/**
 * Copy for the retry ladder in PhotoCapture giving up.
 *
 * Only reachable when every attempt came back LOW_CONFIDENCE or NO_MATCH: the
 * server throws those instead of returning results, so no attempt ever left a
 * candidate behind to fall back on. A run that saw even one weak-but-real match
 * proceeds with it instead of landing here.
 */
export function describeRetriesExhausted(organ, attempts) {
  return {
    code: 'RETRIES_EXHAUSTED',
    title: `No match after ${attempts} photos`,
    guidance: WEAK_ORGANS.has(organ)
      ? 'None of them identified as anything. Leaves and bark look alike across whole genera — ' +
        'if this plant has a flower or fruit on it, photograph that instead.'
      : 'None of them identified as anything. Try a single plant against a plain background, ' +
        'or come back when the light is better.',
    canRetry: true,
  }
}

/** Same idea for POST /api/catches, whose failure modes are entirely different. */
export function describeSubmitError(err) {
  const data = err?.response?.data ?? {}
  const detail = typeof data.error === 'string' ? data.error : null

  switch (data.code) {
    case 'DUPLICATE_CATCH':
      return {
        code: data.code,
        title: 'Already in your catalogue',
        guidance: detail ?? 'You have already logged this species here.',
        canRetry: false,
      }
    case 'DB_NOT_CONFIGURED':
      return {
        code: data.code,
        title: 'Catches are not being saved',
        guidance: 'The server has no database configured, so there is nowhere to record this.',
        canRetry: false,
      }
    case 'TAXON_NOT_FOUND':
      return {
        code: data.code,
        title: 'iNaturalist does not know this species',
        guidance: 'It could not be matched to a taxon, so it cannot be recorded. Try another candidate.',
        canRetry: false,
      }
    default:
      return {
        code: data.code ?? 'UNKNOWN',
        title: 'Could not save that catch',
        guidance: detail ?? 'The server rejected it. Try again in a moment.',
        canRetry: true,
      }
  }
}
