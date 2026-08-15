// iNaturalist lookups: taxon id resolution, establishment means, phenology, and
// the "catchable nearby" species list.
//
// Everything here hits the public v1 API, which needs no key — but it is a
// courtesy-use service, so we send a real User-Agent, cap page sizes, and cache
// the two lookups that would otherwise repeat per catch (see CACHE_TTL_MS).
//
// Return shapes mirror the fixtures in ../mocks.js (SPECIES_STATUS,
// PHENOLOGY_HISTOGRAM, NEARBY_SPECIES) so routes can swap between real and mock
// data without the client noticing.

const API_BASE = 'https://api.inaturalist.org/v1'
const REQUEST_TIMEOUT_MS = 15_000

// api.inaturalist.org asks for an identifying User-Agent so they can contact
// you before they block you. Override via INAT_USER_AGENT if the demo gets
// noisy enough for anyone to notice.
const USER_AGENT =
  process.env.INAT_USER_AGENT ??
  'OregonHacksBiodiversity/0.1 (https://github.com/NotCoolYoshi/oregonhacks-biodiversity)'

const MAX_PER_PAGE = 50
const DEFAULT_PER_PAGE = 20

// A taxon's establishment means in a place does not change during a hackathon.
const CACHE_TTL_MS = 10 * 60 * 1000

// iNaturalist's establishment_means vocabulary. Anything in THREAT_MEANS is a
// species that does not belong here, which is what turns a capture into a
// threat report.
const NATIVE_MEANS = new Set(['native', 'endemic'])
const THREAT_MEANS = new Set(['introduced', 'invasive', 'naturalised', 'naturalized'])

/** An error we've already translated into something safe to show a user. */
export class INaturalistError extends Error {
  constructor(message, { status = 502, code = 'INATURALIST_ERROR', retryAfter } = {}) {
    super(message)
    this.name = 'INaturalistError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Translate an upstream failure into a status code that means something here. */
async function toINaturalistError(response) {
  let detail = ''
  try {
    const text = await response.text()
    detail = (JSON.parse(text)?.error ?? text ?? '').toString().slice(0, 300)
  } catch {
    /* body was empty or unparseable — the status code carries the meaning */
  }

  switch (response.status) {
    case 404:
      return new INaturalistError('iNaturalist has no record for that taxon or place.', {
        status: 404,
        code: 'NOT_FOUND',
      })
    case 422:
      return new INaturalistError(
        `iNaturalist rejected the request${detail ? `: ${detail}` : ''}`,
        { status: 400, code: 'BAD_REQUEST' },
      )
    case 429:
      return new INaturalistError(
        'iNaturalist is rate-limiting us (their cap is ~60 requests/minute). Slow down and retry.',
        {
          status: 429,
          code: 'RATE_LIMITED',
          retryAfter: response.headers.get('retry-after') ?? undefined,
        },
      )
    default:
      return new INaturalistError(
        `iNaturalist is unavailable (upstream ${response.status})${detail ? `: ${detail}` : ''}`,
        { status: 502, code: 'UPSTREAM_UNAVAILABLE' },
      )
  }
}

/** GET a v1 endpoint and return the parsed body, or throw an INaturalistError. */
async function get(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value))
  }

  let response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new INaturalistError('iNaturalist did not respond in time.', {
        status: 504,
        code: 'UPSTREAM_TIMEOUT',
      })
    }
    throw new INaturalistError(`Could not reach iNaturalist: ${err.message}`, {
      status: 502,
      code: 'UPSTREAM_UNREACHABLE',
    })
  }

  if (!response.ok) throw await toINaturalistError(response)

  try {
    return await response.json()
  } catch {
    throw new INaturalistError('iNaturalist returned a response we could not parse.', {
      status: 502,
      code: 'BAD_UPSTREAM_RESPONSE',
    })
  }
}

/** Tiny TTL memo — enough to keep a burst of catches off the upstream API. */
const cache = new Map()

async function cached(key, fn) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const value = await fn()
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * `establishment_means` comes back place-scoped when we pass `place_id`, and as
 * null when iNaturalist has no checklist entry for that taxon in that place.
 * Null is genuinely "we don't know", not "native" — the caller has to decide
 * what to do with that, so we pass 'unknown' through rather than guessing.
 */
function readEstablishmentMeans(taxon, placeId) {
  const direct = taxon.establishment_means
  if (direct?.establishment_means) {
    // Trust it only if it is actually about the place we asked about.
    if (direct.place?.id == null || Number(direct.place.id) === Number(placeId)) {
      return direct.establishment_means.toLowerCase()
    }
  }

  // Fall back to the checklist entries, which include ancestor places (a taxon
  // introduced to "North America" is introduced to Oregon too).
  const listed = taxon.listed_taxa?.find(
    (entry) => Number(entry.place?.id) === Number(placeId) && entry.establishment_means,
  )
  if (listed) return listed.establishment_means.toLowerCase()

  return 'unknown'
}

function classify(establishmentMeans) {
  const isNative = NATIVE_MEANS.has(establishmentMeans)
  const isInvasive = THREAT_MEANS.has(establishmentMeans)

  return {
    isNative: establishmentMeans === 'unknown' ? null : isNative,
    isInvasive,
    // Unknown means falls through to 'catch': a species we can't classify is
    // not evidence of a threat, and refusing the capture would punish the user
    // for a gap in iNaturalist's checklists.
    classification: isInvasive ? 'threat_report' : 'catch',
  }
}

function mapConservationStatus(taxon) {
  const status = taxon.conservation_status
  if (!status?.status) return null

  return {
    status: status.status.toUpperCase(),
    statusName: status.status_name ?? null,
    authority: status.authority ?? null,
  }
}

function photoUrl(taxon) {
  const photo = taxon.default_photo
  return photo?.square_url ?? photo?.url ?? photo?.medium_url ?? null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scientific name -> iNaturalist taxon id.
 *
 * Pl@ntNet only gives us GBIF ids (see services/plantnet.js), so every real
 * identification arrives with `inatTaxonId: null` and has to come through here
 * before any status or phenology lookup can happen.
 *
 * @param {string} scientificName e.g. 'Mahonia aquifolium'
 * @returns {Promise<number>}
 */
export async function resolveTaxonId(scientificName) {
  const name = String(scientificName ?? '').trim()
  if (!name) {
    throw new INaturalistError('scientific_name is required to resolve a taxon id.', {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  return cached(`resolve:${name.toLowerCase()}`, async () => {
    const payload = await get('/taxa', { q: name, per_page: 1, is_active: 'true' })
    const match = payload.results?.[0]

    if (!match?.id) {
      throw new INaturalistError(`iNaturalist has no taxon matching "${name}".`, {
        status: 404,
        code: 'TAXON_NOT_FOUND',
      })
    }

    return match.id
  })
}

/**
 * Establishment means + conservation status for a taxon in a place.
 *
 * `classification` is the field that decides catch vs. threat report, and it is
 * computed here rather than in the client on purpose — a client that can name
 * its own classification can farm points.
 *
 * @returns {Promise<object>} same shape as mocks.SPECIES_STATUS entries
 */
export async function getTaxonStatus(taxonId, placeId) {
  const id = Number(taxonId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new INaturalistError(`taxonId must be a positive number (got "${taxonId}").`, {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  return cached(`status:${id}:${placeId}`, async () => {
    const payload = await get(`/taxa/${id}`, { place_id: placeId })
    const taxon = payload.results?.[0]

    if (!taxon) {
      throw new INaturalistError(`iNaturalist has no taxon with id ${id}.`, {
        status: 404,
        code: 'TAXON_NOT_FOUND',
      })
    }

    const establishmentMeans = readEstablishmentMeans(taxon, placeId)

    return {
      taxonId: taxon.id,
      scientificName: taxon.name ?? null,
      commonName: taxon.preferred_common_name ?? null,
      rank: taxon.rank ?? null,
      establishmentMeans,
      ...classify(establishmentMeans),
      conservationStatus: mapConservationStatus(taxon),
      observationCount: taxon.observations_count ?? 0,
      defaultPhotoUrl: photoUrl(taxon),
      wikipediaUrl: taxon.wikipedia_url ?? null,
    }
  })
}

/**
 * Monthly observation counts for a taxon in a place, Jan..Dec.
 *
 * iNaturalist omits months with no observations; we fill them with 0 so callers
 * can always index 1..12 without a guard.
 *
 * @returns {Promise<Record<number, number>>} same shape as mocks.PHENOLOGY_HISTOGRAM
 */
export async function getPhenology(taxonId, placeId) {
  const id = Number(taxonId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new INaturalistError(`taxonId must be a positive number (got "${taxonId}").`, {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  const payload = await get('/observations/histogram', {
    taxon_id: id,
    place_id: placeId,
    date_field: 'observed',
    interval: 'month_of_year',
    verifiable: 'true',
  })

  const raw = payload.results?.month_of_year ?? {}
  const histogram = {}
  for (let month = 1; month <= 12; month += 1) {
    histogram[month] = Number(raw[month] ?? raw[String(month)] ?? 0)
  }

  return histogram
}

/**
 * Establishment means for many taxa in one place, in a single request.
 *
 * `/taxa/:id` accepts comma-separated ids, so a page of species costs one call
 * rather than one per species. Results are memoised per taxon, so a second
 * caller asking about overlapping ids only pays for the ids it adds.
 *
 * Returns a Map of taxonId -> means. Ids iNaturalist has no checklist entry
 * for come back as 'unknown', which is a real answer and not the same as
 * 'native' — callers that treat it as native will overcount.
 *
 * @param {number[]} taxonIds
 * @param {number} placeId
 * @returns {Promise<Map<number, string>>}
 */
export async function getEstablishmentMeans(taxonIds, placeId) {
  const unique = [...new Set((taxonIds ?? []).map(Number).filter(Boolean))]
  const means = new Map()
  if (unique.length === 0) return means

  const missing = []
  for (const id of unique) {
    const hit = cache.get(`means:${id}:${placeId}`)
    if (hit && hit.expiresAt > Date.now()) means.set(id, hit.value)
    else missing.push(id)
  }

  if (missing.length > 0) {
    // iNaturalist caps a multi-id lookup at 30 taxa per request.
    for (let i = 0; i < missing.length; i += 30) {
      const batch = missing.slice(i, i + 30)
      const detail = await get(`/taxa/${batch.join(',')}`, { place_id: placeId })

      for (const taxon of detail.results ?? []) {
        const value = readEstablishmentMeans(taxon, placeId)
        means.set(taxon.id, value)
        cache.set(`means:${taxon.id}:${placeId}`, {
          value,
          expiresAt: Date.now() + CACHE_TTL_MS,
        })
      }
    }
  }

  return means
}

/** True when iNaturalist positively records this taxon as belonging here. */
export const isNativeMeans = (means) => NATIVE_MEANS.has(means)

/**
 * Species recently observed in (or near) a place — the "catchable nearby" list.
 *
 * species_counts does not include establishment means, so we make one bulk
 * /taxa call for the ids we got back and merge native/invasive flags in. Two
 * requests total, not one per species.
 *
 * @returns {Promise<object[]>} same shape as mocks.NEARBY_SPECIES
 */
export async function getNearbySpecies(placeId, { lat, lng, radius, perPage } = {}) {
  const id = Number(placeId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new INaturalistError(`placeId must be a positive number (got "${placeId}").`, {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  const requestedPerPage = Number(perPage)
  const limit = Math.min(
    Number.isFinite(requestedPerPage) && requestedPerPage > 0 ? requestedPerPage : DEFAULT_PER_PAGE,
    MAX_PER_PAGE,
  )

  // lat/lng/radius narrow the search to the user's surroundings. They only mean
  // anything together, so all three travel as a set or none of them do.
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))

  const payload = await get('/observations/species_counts', {
    place_id: id,
    per_page: limit,
    verifiable: 'true',
    ...(hasCoords ? { lat: Number(lat), lng: Number(lng), radius: Number(radius) || 25 } : {}),
  })

  const rows = payload.results ?? []
  if (rows.length === 0) return []

  // One bulk lookup for establishment means across every taxon in the page.
  const ids = rows.map((row) => row.taxon?.id).filter(Boolean)
  // The nearby list is still useful without native/invasive badges, so a
  // failure here degrades the response instead of failing the request.
  const meansById = await getEstablishmentMeans(ids, id).catch((err) => {
    console.warn(`[inaturalist] establishment means lookup failed: ${err.message}`)
    return new Map()
  })

  return rows.map((row) => {
    const taxon = row.taxon ?? {}
    const establishmentMeans = meansById.get(taxon.id) ?? 'unknown'
    const { isInvasive } = classify(establishmentMeans)

    return {
      taxonId: taxon.id ?? null,
      scientificName: taxon.name ?? null,
      commonName: taxon.preferred_common_name ?? null,
      rank: taxon.rank ?? null,
      observationCount: row.count ?? 0,
      establishmentMeans,
      isInvasive,
      defaultPhotoUrl: photoUrl(taxon),
    }
  })
}
