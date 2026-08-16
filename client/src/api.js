import axios from 'axios'

// Points at the Express proxy layer, never at Pl@ntNet/iNaturalist directly —
// API keys live on the server only.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:5001',
})

/** POST /api/identify — { imageBase64 } -> candidate species matches. */
export const identify = (body) => api.post('/api/identify', body).then((r) => r.data)

/**
 * GET /api/species/:taxonId/status — native / introduced / invasive for a place.
 *
 * Pl@ntNet identifications come back with `inatTaxonId: null` (it only knows
 * GBIF ids), so pass `scientificName` whenever `taxonId` is missing — the
 * server resolves it against iNaturalist before looking up status.
 */
export const getSpeciesStatus = (taxonId, placeId, scientificName) =>
  api
    .get(`/api/species/${taxonId ?? 'unknown'}/status`, {
      params: { place_id: placeId, scientific_name: taxonId ? undefined : scientificName },
    })
    .then((r) => r.data)

/** GET /api/species/:taxonId/phenology — monthly observation histogram. Same fallback as above. */
export const getSpeciesPhenology = (taxonId, placeId, scientificName) =>
  api
    .get(`/api/species/${taxonId ?? 'unknown'}/phenology`, {
      params: { place_id: placeId, scientific_name: taxonId ? undefined : scientificName },
    })
    .then((r) => r.data)

/** GET /api/region/:placeId/nearby — species recently observed near a place. */
export const getNearby = (placeId, params) =>
  api.get(`/api/region/${placeId}/nearby`, { params }).then((r) => r.data)

/** POST /api/catches — record a `catch` or a `threat_report`. */
export const createCatch = (body) => api.post('/api/catches', body).then((r) => r.data)

/**
 * GET /api/catches?userId=&placeId= — recorded catches, newest first.
 *
 * Both params are optional and AND together: pass `placeId` for the map's
 * "everything logged here", `userId` for the dex's "everything I have found".
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