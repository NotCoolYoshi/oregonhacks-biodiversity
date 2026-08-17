import axios from 'axios'

// Points at the Express proxy layer, never at Pl@ntNet/iNaturalist directly —
// API keys live on the server only.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:5001',
})

/** POST /api/identify — { imageBase64 } -> candidate species matches. */
export const identify = (body) => api.post('/api/identify', body).then((r) => r.data)

/**
 * Turn a { lat, lng } into the params every place-scoped route accepts.
 *
 * Coordinates and not a place id: which region a species is native to is a
 * question about where the user is standing, and the server resolves that
 * itself so the client cannot get it wrong (or claim a convenient region).
 * Passing nothing is allowed — the server falls back and says that it did.
 */
const placeParams = (location) =>
  location && Number.isFinite(location.lat) && Number.isFinite(location.lng)
    ? { lat: location.lat, lng: location.lng }
    : {}

/**
 * GET /api/species/:taxonId/status — native / introduced / invasive, where you are.
 *
 * Pl@ntNet identifications come back with `inatTaxonId: null` (it only knows
 * GBIF ids), so pass `scientificName` whenever `taxonId` is missing — the
 * server resolves it against iNaturalist before looking up status.
 *
 * The response carries `placeName` and `placeSource`; a `placeSource` of
 * 'fallback' means the verdict is not about the user's own region and the UI
 * should say so rather than presenting it as local.
 */
export const getSpeciesStatus = (taxonId, location, scientificName) =>
  api
    .get(`/api/species/${taxonId ?? 'unknown'}/status`, {
      params: {
        ...placeParams(location),
        scientific_name: taxonId ? undefined : scientificName,
      },
    })
    .then((r) => r.data)

/** GET /api/species/:taxonId/phenology — monthly observation histogram. Same fallback as above. */
export const getSpeciesPhenology = (taxonId, location, scientificName) =>
  api
    .get(`/api/species/${taxonId ?? 'unknown'}/phenology`, {
      params: {
        ...placeParams(location),
        scientific_name: taxonId ? undefined : scientificName,
      },
    })
    .then((r) => r.data)

/**
 * GET /api/places/resolve — coordinates -> the region whose species list applies.
 *
 * Only the map needs this directly: it has to name a region before there is
 * anything to identify. The capture flow sends coordinates with the catch and
 * lets the server resolve the place as part of classifying it.
 *
 * Rejects with a 404 for coordinates iNaturalist has no place for (mid-ocean).
 */
export const resolvePlace = ({ lat, lng }) =>
  api.get('/api/places/resolve', { params: { lat, lng } }).then((r) => r.data)

/** GET /api/region/:placeId/nearby — species recently observed near a place. */
export const getNearby = (placeId, params) =>
  api.get(`/api/region/${placeId}/nearby`, { params }).then((r) => r.data)

/**
 * GET /api/observations/nearby — plants observed around here that `userId` has
 * not caught yet. The map's "nearby unknown plants" layer.
 *
 * `signal` is not optional in practice: this is called on every pan, and a
 * response for a viewport the user has already left is worse than no response.
 * Pass an AbortController's signal and abort it when the map moves again.
 *
 * The server caps the result at 30 rows however large the radius is.
 */
export const getNearbyObservations = ({ lat, lng, radiusKm, userId }, { signal } = {}) =>
  api
    .get('/api/observations/nearby', {
      params: { lat, lng, radius: radiusKm, userId },
      signal,
    })
    .then((r) => r.data)

/** POST /api/catches — record a `catch` or a `threat_report`. */
export const createCatch = (body) => api.post('/api/catches', body).then((r) => r.data)

/**
 * GET /api/catches?userId=&placeId= — recorded catches, newest first.
 *
 * Both params are optional and AND together: pass `placeId` for the map's
 * "everything logged here", `userId` for the catalogue's "everything I have found".
 * Rows come back in the database's snake_case (taxon_id, common_name, lat, …),
 * unlike createCatch's camelCase response.
 *
 * Rows with a null lat/lng are included — callers that plot them are the ones
 * responsible for skipping the ones with no coordinates.
 */
export const getCatches = (params) =>
  api.get('/api/catches', { params }).then((r) => r.data.catches)

/** GET /api/region/:placeId/score — aggregated regional biodiversity health score. */
export const getRegionScore = (placeId) =>
  api.get(`/api/region/${placeId}/score`).then((r) => r.data)

/**
 * GET /api/users/:userId — one user's name and totals.
 *
 * Resolves to { userId, displayName, totalPoints, catchCount, uniqueSpeciesCount }.
 * Never rejects with a 404: a session that has an id but no row yet — which is
 * every session, briefly — comes back with a null displayName and zeros.
 *
 * `userId` comes from session.js. There is no server-side notion of "current"
 * anything, so it has to be passed in.
 */
export const getCurrentUser = (userId) =>
  api.get(`/api/users/${encodeURIComponent(userId)}`).then((r) => r.data)

/**
 * POST /api/users — create the user's row, or rename it.
 *
 * Called two ways:
 *   updateDisplayName(userId)          establish a row on first load and let
 *                                      the server generate the name.
 *   updateDisplayName(userId, 'Fern')  rename.
 *
 * Idempotent either way, and a blank name is treated as "no name given" rather
 * than as an erasure. Resolves to { userId, displayName, createdAt, created }.
 */
export const updateDisplayName = (userId, displayName) =>
  api.post('/api/users', { userId, displayName }).then((r) => r.data)

/**
 * GET /api/users/:userId/achievements — native and invasive badge state.
 *
 * Resolves to { userId, nativeSpeciesCount, invasiveSpeciesCount, nativeBadges,
 * invasiveBadges }, where each badge is { threshold, label, unlocked }.
 * Computed server-side on every call, not stored — see the route for why.
 */
export const getUserAchievements = (userId) =>
  api.get(`/api/users/${encodeURIComponent(userId)}/achievements`).then((r) => r.data)

/**
 * GET /api/leaderboard — users ranked by total points, highest first.
 *
 * Resolves to `{ userId, displayName, totalPoints, uniqueSpeciesCount }[]`.
 * Computed server-side on every call from the same `sightings` rows
 * GET /api/users/:userId sums, so the two never disagree.
 */
export const getLeaderboard = () => api.get('/api/leaderboard').then((r) => r.data)
