/**
 * Facts derivable from a catch row itself, with no extra request.
 *
 * The distinction matters: everything here is read off columns the row already
 * has (created_at, lat, lng). Anything needing an API — live weather, IUCN
 * status — belongs to whoever fetches it, not here.
 */

// Meteorological seasons: whole months, unlike the astronomical ones that turn
// on a solstice partway through December. Month-to-season is the whole point —
// a date is all we have.
const NORTHERN = {
  12: 'Winter', 1: 'Winter', 2: 'Winter',
  3: 'Spring', 4: 'Spring', 5: 'Spring',
  6: 'Summer', 7: 'Summer', 8: 'Summer',
  9: 'Autumn', 10: 'Autumn', 11: 'Autumn',
}

const OPPOSITE = {
  Winter: 'Summer',
  Summer: 'Winter',
  Spring: 'Autumn',
  Autumn: 'Spring',
}

/**
 * The season a catch was made in.
 *
 * Hemisphere-aware, because the app is no longer Oregon-only and a March catch
 * in Sydney is autumn. `lat` is optional — a catch logged without geolocation
 * gets the northern reading, which is a guess, and the caller is told so via
 * `assumedHemisphere`.
 *
 * @param {string} createdAt ISO timestamp from the catch row
 * @param {number|null} lat
 */
export function seasonOf(createdAt, lat) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null

  const month = date.getMonth() + 1
  const northern = NORTHERN[month]
  const southern = typeof lat === 'number' && lat < 0

  return {
    season: southern ? OPPOSITE[northern] : northern,
    month,
    hemisphere: southern ? 'southern' : 'northern',
    // True when there was no latitude to read and 'northern' is an assumption
    // rather than a fact.
    assumedHemisphere: typeof lat !== 'number',
  }
}

const EARTH_RADIUS_KM = 6371
const toRadians = (degrees) => (degrees * Math.PI) / 180

/** Great-circle distance in km. Plenty accurate for "is this nearby". */
export function distanceKm(a, b) {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

/** A catch that can be placed on the map. Rows without geolocation cannot. */
export const hasLocation = (row) =>
  typeof row?.lat === 'number' && typeof row?.lng === 'number'

/** Coordinates as a label. Three decimals is ~100m — enough to find a bush. */
export const formatCoords = (row) =>
  hasLocation(row) ? `${row.lat.toFixed(3)}, ${row.lng.toFixed(3)}` : null
