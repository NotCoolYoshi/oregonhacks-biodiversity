// Pl@ntNet photo identification.
//
// The API key lives here and only here — it is read from process.env and never
// appears in a response body. Callers get back the same shape as
// IDENTIFY_RESULT in ../mocks.js, so the route can swap between real and mock
// data without the client noticing.

const PLANTNET_ENDPOINT = 'https://my-api.plantnet.org/v2/identify/all'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESULTS = 5

// Below this top score, Pl@ntNet is guessing. Surfacing a 3%-confidence match as
// a catch would let users fill their catalogue with noise, so we reject it instead.
const MIN_CONFIDENCE = 0.1

// Pl@ntNet needs to know which part of the plant it's looking at. 'auto' lets it
// decide, which is the right default for a point-and-shoot capture flow.
const VALID_ORGANS = new Set(['leaf', 'flower', 'fruit', 'bark', 'habit', 'other', 'auto'])
const DEFAULT_ORGAN = 'auto'

/** An error we've already translated into something safe to show a user. */
export class PlantNetError extends Error {
  constructor(message, { status = 502, code = 'PLANTNET_ERROR', retryAfter } = {}) {
    super(message)
    this.name = 'PlantNetError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** True when a usable key is configured. Drives the mock fallback in the route. */
export const hasApiKey = () => Boolean(process.env.PLANTNET_API_KEY?.trim())

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i

function decodeImage(imageBase64) {
  const match = imageBase64.match(DATA_URL_RE)
  const mimeType = match ? match[1].toLowerCase() : 'image/jpeg'
  const payload = match ? imageBase64.slice(match[0].length) : imageBase64

  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length === 0) {
    throw new PlantNetError('imageBase64 is not valid base64 image data', {
      status: 400,
      code: 'BAD_IMAGE',
    })
  }

  return { buffer, mimeType }
}

function normalizeOrgans(organs, imageCount) {
  const requested = Array.isArray(organs) ? organs : organs ? [organs] : []
  return Array.from({ length: imageCount }, (_, i) => {
    const organ = String(requested[i] ?? requested[0] ?? DEFAULT_ORGAN).toLowerCase()
    return VALID_ORGANS.has(organ) ? organ : DEFAULT_ORGAN
  })
}

/**
 * Pl@ntNet gives us GBIF ids but not iNaturalist taxon ids.
 *
 * `inatTaxonId` is what /api/species/:taxonId/status and /phenology key off, so
 * until the iNaturalist pass resolves it (scientific name -> taxon id, then
 * cache it), it comes back null on real identifications. The field is kept in
 * the response so the shape stays stable.
 */
function mapResult(result) {
  const species = result.species ?? {}
  const image = result.images?.[0]?.url ?? {}

  return {
    score: Number(result.score?.toFixed?.(4) ?? result.score ?? 0),
    scientificName: species.scientificNameWithoutAuthor ?? null,
    genus: species.genus?.scientificNameWithoutAuthor ?? null,
    family: species.family?.scientificNameWithoutAuthor ?? null,
    commonNames: species.commonNames ?? [],
    gbifId: result.gbif?.id != null ? String(result.gbif.id) : null,
    inatTaxonId: null,
    imageUrl: image.m ?? image.o ?? image.s ?? null,
  }
}

/** Translate an upstream failure into a status code that means something here. */
async function toPlantNetError(response) {
  let detail = ''
  try {
    const text = await response.text()
    detail = (JSON.parse(text)?.message ?? text ?? '').toString().slice(0, 300)
  } catch {
    /* body was empty or unparseable — the status code carries the meaning */
  }

  switch (response.status) {
    case 401:
    case 403:
      // Our key, our problem — the caller can do nothing about this.
      return new PlantNetError(
        'Pl@ntNet rejected the API key. Check PLANTNET_API_KEY in server/.env.',
        { status: 500, code: 'PLANTNET_AUTH' },
      )
    case 404:
      return new PlantNetError('Pl@ntNet could not match this photo to any species.', {
        status: 404,
        code: 'NO_MATCH',
      })
    case 413:
      return new PlantNetError('Photo is too large for Pl@ntNet. Try a smaller image.', {
        status: 413,
        code: 'IMAGE_TOO_LARGE',
      })
    case 429:
      return new PlantNetError(
        'Pl@ntNet daily quota exceeded (free tier is 500 identifications/day). Try again tomorrow.',
        {
          status: 429,
          code: 'QUOTA_EXCEEDED',
          retryAfter: response.headers.get('retry-after') ?? undefined,
        },
      )
    case 400:
      return new PlantNetError(`Pl@ntNet rejected the request: ${detail || 'bad image or organ'}`, {
        status: 400,
        code: 'BAD_REQUEST',
      })
    default:
      return new PlantNetError(
        `Pl@ntNet is unavailable (upstream ${response.status})${detail ? `: ${detail}` : ''}`,
        { status: 502, code: 'UPSTREAM_UNAVAILABLE' },
      )
  }
}

/**
 * Identify a plant from a photo.
 *
 * @param {{ imageBase64?: string, imageUrl?: string, organs?: string[] }} input
 * @returns {Promise<object>} same shape as mocks.IDENTIFY_RESULT
 */
export async function identifyPlant({ imageBase64, imageUrl, organs }) {
  const apiKey = process.env.PLANTNET_API_KEY?.trim()
  if (!apiKey) {
    throw new PlantNetError('PLANTNET_API_KEY is not configured on the server.', {
      status: 500,
      code: 'PLANTNET_AUTH',
    })
  }

  const url = new URL(PLANTNET_ENDPOINT)
  url.searchParams.set('api-key', apiKey)
  url.searchParams.set('lang', 'en')
  url.searchParams.set('nb-results', String(MAX_RESULTS))

  const base64 = typeof imageBase64 === 'string' ? imageBase64.trim() : ''
  const url_ = typeof imageUrl === 'string' ? imageUrl.trim() : ''
  if (!base64 && !url_) {
    throw new PlantNetError('imageBase64 or imageUrl is required', {
      status: 400,
      code: 'BAD_IMAGE',
    })
  }

  const resolvedOrgans = normalizeOrgans(organs, 1)
  let body

  if (base64) {
    const { buffer, mimeType } = decodeImage(base64)
    const form = new FormData()
    form.append('images', new Blob([buffer], { type: mimeType }), 'capture.jpg')
    form.append('organs', resolvedOrgans[0])
    body = form
  } else {
    // Pl@ntNet also accepts image URLs as repeated query params.
    url.searchParams.append('images', url_)
    url.searchParams.append('organs', resolvedOrgans[0])
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new PlantNetError('Pl@ntNet did not respond in time.', {
        status: 504,
        code: 'UPSTREAM_TIMEOUT',
      })
    }
    throw new PlantNetError(`Could not reach Pl@ntNet: ${err.message}`, {
      status: 502,
      code: 'UPSTREAM_UNREACHABLE',
    })
  }

  if (!response.ok) {
    throw await toPlantNetError(response)
  }

  const payload = await response.json()
  const results = (payload.results ?? []).map(mapResult)

  if (results.length === 0) {
    throw new PlantNetError('Pl@ntNet could not match this photo to any species.', {
      status: 404,
      code: 'NO_MATCH',
    })
  }

  const best = results[0]
  if (best.score < MIN_CONFIDENCE) {
    throw new PlantNetError(
      `No confident match. Closest guess was ${best.scientificName} at ` +
        `${Math.round(best.score * 100)}% — try a clearer photo of a single leaf or flower.`,
      { status: 404, code: 'LOW_CONFIDENCE' },
    )
  }

  return {
    query: { imageCount: 1, organs: resolvedOrgans },
    bestMatch: best.scientificName,
    results,
    source: 'plantnet',
    remainingRequests: payload.remainingIdentificationRequests ?? null,
  }
}
