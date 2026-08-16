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

// Which place a coordinate falls in changes on the timescale of redistricting,
// not of a demo. Cached far longer than establishment means so the extra hop
// added to every catch is paid once per area rather than once per capture.
const PLACE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

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

async function cached(key, fn, ttlMs = CACHE_TTL_MS) {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const value = await fn()
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
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

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/**
 * Administrative levels in iNaturalist's `standard` place set, best first.
 *
 * State (10) leads on purpose, and not because it is the most precise answer
 * available — /places/nearby also returns counties (20) and cities. It leads
 * because it is the level iNaturalist actually maintains species checklists at.
 * `establishment_means` comes back null for most taxa when you ask about a
 * county, and readEstablishmentMeans() reads null as 'unknown', which classify()
 * files as a plain catch. Asking a more precise question would therefore get us
 * a less useful answer: a confidently-native plant would come back unclassified.
 *
 * Country (0) is the last resort rather than an omission — for a coordinate in
 * a place iNaturalist has no state-equivalent for, a national checklist still
 * beats defaulting to somewhere the user has never been.
 */
const PLACE_ADMIN_PREFERENCE = [10, 20, 0]

// Half-width of the bounding box sent to /places/nearby, in degrees (~1.1km).
// The endpoint takes a box, not a point; this is the smallest one that reliably
// comes back with the containing places rather than an empty set.
const PLACE_BBOX_DEGREES = 0.01

/** Coordinates rounded to the cache's resolution — ~1km, so a walk is one key. */
const placeCacheKey = (lat, lng) => `place:${lat.toFixed(2)},${lng.toFixed(2)}`

/**
 * Coordinates -> the iNaturalist place whose species list they should be
 * checked against.
 *
 * This is what makes the native/invasive verdict about where the user actually
 * is. Before it existed every capture was compared against a fixed place id,
 * so a palo verde photographed in Arizona was checked against Oregon's
 * checklist and came back "not native to Oregon" — true, and not the question
 * anyone asked.
 *
 * Returns null rather than throwing when the coordinates land somewhere
 * iNaturalist has no standard place for (mid-ocean, Antarctica). A caller that
 * cannot name a place is better off saying so than being handed a guess.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{ placeId: number, placeName: string, adminLevel: number|null } | null>}
 */
export async function resolvePlaceFromCoords(lat, lng) {
  const latitude = Number(lat)
  const longitude = Number(lng)

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new INaturalistError(
      `lat and lng must both be numbers (got "${lat}", "${lng}").`,
      { status: 400, code: 'BAD_REQUEST' },
    )
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new INaturalistError(
      `lat must be between -90 and 90 and lng between -180 and 180 (got ${latitude}, ${longitude}).`,
      { status: 400, code: 'BAD_REQUEST' },
    )
  }

  return cached(
    placeCacheKey(latitude, longitude),
    async () => {
      const payload = await get('/places/nearby', {
        nelat: latitude + PLACE_BBOX_DEGREES,
        nelng: longitude + PLACE_BBOX_DEGREES,
        swlat: latitude - PLACE_BBOX_DEGREES,
        swlng: longitude - PLACE_BBOX_DEGREES,
        per_page: 20,
      })

      // `community` places are user-drawn — parks, campuses, "Metro Phoenix" —
      // and carry no admin_level and no checklist. Only `standard` can answer
      // an establishment-means question, so only `standard` is considered.
      const standard = payload.results?.standard ?? []

      for (const level of PLACE_ADMIN_PREFERENCE) {
        const match = standard.find((place) => Number(place.admin_level) === level)
        if (match?.id) {
          // display_name disambiguates ("Lane County, OR, US" over "Lane"),
          // which matters as soon as the app spans more than one state.
          const name = match.display_name ?? match.name ?? `Place ${match.id}`
          // Populate the id->name cache too: the place we just named is the one
          // the score and list routes are about to ask about by id alone.
          cache.set(`placeName:${match.id}`, {
            value: name,
            expiresAt: Date.now() + PLACE_CACHE_TTL_MS,
          })
          return { placeId: match.id, placeName: name, adminLevel: level }
        }
      }

      return null
    },
    PLACE_CACHE_TTL_MS,
  )
}

/**
 * Place id -> display name, for the routes that only ever receive an id.
 *
 * Rejects rather than resolving to a placeholder: callers decide their own
 * fallback, and every one of them already has a better one than a made-up name.
 */
export async function getPlaceName(placeId) {
  const id = Number(placeId)
  if (!Number.isFinite(id) || id <= 0) {
    throw new INaturalistError(`placeId must be a positive number (got "${placeId}").`, {
      status: 400,
      code: 'BAD_REQUEST',
    })
  }

  return cached(
    `placeName:${id}`,
    async () => {
      const payload = await get(`/places/${id}`)
      const place = payload.results?.[0]
      if (!place) {
        throw new INaturalistError(`iNaturalist has no place with id ${id}.`, {
          status: 404,
          code: 'PLACE_NOT_FOUND',
        })
      }
      return place.display_name ?? place.name ?? `Place ${id}`
    },
    PLACE_CACHE_TTL_MS,
  )
}

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
