import L from 'leaflet'

/**
 * The region shading layer: a density heatmap of everything that has been
 * recorded, drawn under the pins.
 *
 * ---------------------------------------------------------------------------
 * What it is, and what it is not
 *
 * This shades where records are, not where a region's boundary is. Real region
 * shading would need boundary polygons — iNaturalist place GeoJSON, one request
 * per place, reprojected and clipped — and this is a density field standing in
 * for that. It is honest about the same thing the Region Health stat above the
 * map is honest about: both are readings of *what has been found here*, and
 * neither is a survey.
 *
 * Which is also why the gradient is the stat strip's own palette rather than
 * the plugin's default blue-to-red. The strip is a deep-green slab with accent
 * yellow numerals; the shading runs the same deep green to the same yellow, so
 * "more colour" means the same thing in both places, and neither borrows the
 * red that this app uses for nothing.
 */
const HEAT_GRADIENT = {
  0.2: '#1a4531',
  0.5: '#2f6b45',
  0.75: '#7ba05b',
  1.0: '#f0cf6b',
}

/**
 * Roughly 2km at this latitude. Cells are in degrees, so they narrow towards
 * the poles — fine for calibrating a colour ramp, and not fine for anything
 * that claimed to measure area.
 */
const CELL_DEGREES = 0.02

/**
 * What counts as fully saturated, read off the data rather than fixed.
 *
 * leaflet.heat's `max` defaults to 1, which renders a single lone pin at full
 * intensity — a map with one catch on it would claim to be uniformly dense. But
 * a constant is no better: pick 8 and this app's real dataset (a couple of
 * dozen records, in two clusters) paints almost nothing, and the layer looks
 * broken rather than sparse.
 *
 * So the peak is whatever the busiest ~2km cell actually holds. The ramp then
 * always spans the data in front of it: the densest place on screen is yellow
 * and the thin places are green, whether that is three records or three
 * thousand. The reading is relative — "more records than over there", not "more
 * than some absolute count" — which is what the legend says and all a density
 * field can honestly support.
 *
 * Floored at 2 so that a scatter of isolated records reads as thin rather than
 * as uniformly maximal.
 */
function saturationFor(points) {
  const cells = new Map()
  let peak = 0

  for (const [lat, lng] of points) {
    const key = `${Math.round(lat / CELL_DEGREES)}:${Math.round(lng / CELL_DEGREES)}`
    const count = (cells.get(key) ?? 0) + 1
    cells.set(key, count)
    if (count > peak) peak = count
  }

  return Math.max(2, peak)
}

const HEAT_OPTIONS = {
  // Wider than the plugin's default. This is standing in for region shading, so
  // it wants to read as an area with a soft edge rather than as a dot per
  // record — and a tight kernel over a cluster of pins is hidden by the pins.
  radius: 35,
  blur: 25,
  // Enough that a single record is faintly visible rather than invisible, low
  // enough that it does not wash out the map tiles underneath it.
  minOpacity: 0.22,
  gradient: HEAT_GRADIENT,

  /**
   * Not a zoom limit — an intensity damper, and one we do not want.
   *
   * leaflet.heat multiplies every point's weight by 1/2^(maxZoom - zoom), and
   * defaults maxZoom to the tile layer's, which is 18. At the zoom 11 this map
   * opens on that is a weight of 1/128, far below `max` however `max` is
   * chosen, so every cell clamps to minOpacity: one flat colour at the bottom
   * of the ramp, everywhere, at every density. The layer looks like a bug.
   *
   * Pinning it to 0 makes the multiplier 1 at every zoom this map can reach,
   * which hands normalisation entirely to `max` — where saturationFor can do it
   * against the actual data instead of against the tile pyramid.
   */
  maxZoom: 0,
}

/**
 * Load the plugin, once, on demand.
 *
 * leaflet.heat is a 2014-era plugin: no imports, no exports, just a script that
 * assigns `L.heatLayer` against a global `L` that ES modules never provide. So
 * the global has to be there before the plugin's body runs, which is what the
 * assignment below is for and why the import is dynamic — a static `import`
 * would be hoisted above it and blow up on a ReferenceError.
 *
 * The dynamic import earns its keep twice over: the shading layer is off by
 * default, so the plugin is not in the initial bundle and is never fetched by
 * anyone who does not switch it on.
 */
let pending = null

function loadHeatPlugin() {
  if (L.heatLayer) return Promise.resolve()
  if (!pending) {
    window.L = window.L ?? L
    pending = import('leaflet.heat').catch((err) => {
      // Let the next attempt try again rather than caching the failure
      // forever — a chunk that failed to load once is usually a blip.
      pending = null
      throw err
    })
  }
  return pending
}

/**
 * Add a heat layer for `points` to `map`, resolving to a teardown function.
 *
 * `points` are [lat, lng, weight] triples. Rejects if the plugin will not load;
 * the caller is expected to treat that as "no shading" rather than as an error
 * worth showing, in the same spirit as the nearby-plants layer.
 */
export async function addRegionShading(map, points) {
  await loadHeatPlugin()

  const layer = L.heatLayer(points, { ...HEAT_OPTIONS, max: saturationFor(points) })
  layer.addTo(map)

  return () => {
    map.removeLayer(layer)
  }
}
