import L from 'leaflet'

import { ICON_CATEGORIES, UNKNOWN, isIconCategory } from './taxonCategory'

/**
 * Map markers for catches and threat reports: a frame that says *what kind of
 * record* this is, and a glyph inside it that says *what kind of plant*.
 *
 * ---------------------------------------------------------------------------
 * Why one SVG rather than a span and some CSS
 *
 * The pins these replace were a CSS-coloured <span>, and the threat pin got its
 * diamond from `transform: rotate(45deg)` on that span. That trick does not
 * survive a glyph: rotating the frame rotates whatever is drawn inside it, and
 * a 45°-tilted tree reads as a mistake. Drawing the whole marker as one SVG
 * puts the rotation on the frame's own `transform` attribute, in SVG
 * coordinates, and leaves the glyph upright.
 *
 * The Leaflet hazard the old comment warned about still applies and is now
 * structural rather than remembered: Leaflet positions markers by writing
 * `transform: translate3d(...)` onto the icon div, so nothing here sets a CSS
 * transform on anything. The only rotation in this file is an SVG attribute.
 *
 * ---------------------------------------------------------------------------
 * Tide & Timber
 *
 * Deep green #1A4531 fills both frames. The glyph is white on a catch and
 * accent yellow #F0CF6B on a threat report, which layers the palette's own
 * "this one is a problem" colour on top of the shape distinction the map
 * already had — so the two stay tellable apart by form alone for anyone who
 * cannot separate the hues, and gain a second cue for everyone who can.
 *
 * ---------------------------------------------------------------------------
 * Geometry
 *
 * 26×26, centred on (13,13). The diamond is the tighter of the two frames: a
 * 14.4 square rotated 45° inscribes a circle of radius 7.2, so a glyph is only
 * safely inside both frames if it stays within |x−13| + |y−13| ≲ 10 of centre.
 * Every path below is drawn to that budget, which is why the glyphs are taller
 * than they are wide.
 */

const SIZE = 26
const BASE = '#1a4531'
const ACCENT = '#f0cf6b'

/** Frame outlines, in SVG path/shape markup. Drawn twice — see markerSvg. */
const FRAMES = {
  catch: '<circle cx="13" cy="13" r="10.6" />',
  // A square given its 45° turn by an SVG attribute, not by CSS.
  threat_report:
    '<rect x="5.8" y="5.8" width="14.4" height="14.4" rx="2.2" transform="rotate(45 13 13)" />',
}

/**
 * The glyphs, one per category.
 *
 * Stroked shapes take the accent colour from `currentColor`; solid shapes that
 * need to punch back through to the frame (the flower's eye) use the base
 * green directly. Kept as markup strings rather than components because these
 * are handed to L.divIcon as HTML, never rendered by React.
 */
const GLYPHS = {
  // Trunk and canopy. The simplest silhouette that is not mistakable for the
  // bush below it: one mass, held up on a stem.
  tree:
    '<path d="M13 18.6 V 13.6" />' +
    '<circle cx="13" cy="10.8" r="3.6" fill="currentColor" stroke="none" />',

  // A wide, flat-bottomed clump. Low and stemless is the whole distinction from
  // the tree above it, so the rect that squares off the base is doing real
  // work — three loose circles read as a cloud, and a separate ground line
  // under them reads as a mistake.
  shrub:
    '<circle cx="10.5" cy="13.4" r="2.7" fill="currentColor" stroke="none" />' +
    '<circle cx="15.5" cy="13.4" r="2.7" fill="currentColor" stroke="none" />' +
    '<circle cx="13" cy="10.9" r="3" fill="currentColor" stroke="none" />' +
    '<rect x="7.8" y="13.4" width="10.4" height="3.2" rx="1" ' +
    'fill="currentColor" stroke="none" />',

  // Five petals on a stem, with the eye knocked back out to the frame colour so
  // the head does not read as one solid blob at this size.
  wildflower:
    '<path d="M13 18.6 V 13.2" />' +
    '<circle cx="13" cy="7.9" r="1.9" fill="currentColor" stroke="none" />' +
    '<circle cx="10.53" cy="9.7" r="1.9" fill="currentColor" stroke="none" />' +
    '<circle cx="11.47" cy="12.6" r="1.9" fill="currentColor" stroke="none" />' +
    '<circle cx="14.53" cy="12.6" r="1.9" fill="currentColor" stroke="none" />' +
    '<circle cx="15.47" cy="9.7" r="1.9" fill="currentColor" stroke="none" />' +
    `<circle cx="13" cy="10.5" r="1.45" fill="${BASE}" stroke="none" />`,

  // A saguaro. Arms at different heights, because two symmetrical ones read as
  // a candelabra rather than a cactus.
  cactus_succulent:
    '<path d="M13 18.6 V 8" />' +
    '<path d="M13 14 H 10 V 11" />' +
    '<path d="M13 12.4 H 16 V 9.4" />',

  // Blades fanning from a single tuft — grasses, sedges and ferns all read this
  // way in silhouette, which is why they share one bucket. The outer two arch
  // well out and stop short of the top: three near-vertical strokes make a
  // trident, and the splay is what makes it grass.
  grass_fern:
    '<path d="M13 18.6 C 12.2 14.6, 10.8 11.9, 8.6 10" />' +
    '<path d="M13 18.6 V 8.4" />' +
    '<path d="M13 18.6 C 13.8 14.6, 15.2 11.9, 17.4 10" />',

  // A question mark, drawn rather than typeset so it cannot shift with whatever
  // font the page happens to have loaded. Deliberately not a leaf: a vague
  // plant shape would be read as a sixth kind of plant instead of as "we could
  // not tell".
  unknown:
    '<path d="M10.6 11 a2.6 2.6 0 1 1 3.7 2.35 c-0.8 0.4 -1.3 1 -1.3 1.95 v0.5" />' +
    '<circle cx="13" cy="17.7" r="1.15" fill="currentColor" stroke="none" />',
}

/**
 * One marker, as SVG markup.
 *
 * The frame is stroked twice: once wide in translucent black, once narrow in
 * white on top. That reproduces the halo the old pins got from a `box-shadow`,
 * which is what keeps a marker's edge visible over pale map tiles — a plain
 * white border vanishes against a white parking lot.
 */
function markerSvg(type, category) {
  const frame = FRAMES[type] ?? FRAMES.catch
  const glyph = GLYPHS[category] ?? GLYPHS[UNKNOWN]
  const accent = type === 'threat_report' ? ACCENT : '#ffffff'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" ` +
    `width="${SIZE}" height="${SIZE}" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="3.4">${frame}</g>` +
    `<g fill="${BASE}" stroke="#ffffff" stroke-width="2">${frame}</g>` +
    `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round" color="${accent}">${glyph}</g>` +
    '</svg>'
  )
}

/**
 * Built once per (type, category) pair and reused.
 *
 * Leaflet reads `icon.options.html` on every marker render, and there are only
 * twelve distinct markers in the whole design — building a fresh L.divIcon per
 * pin would allocate one object per catch on every pan for no benefit.
 */
const cache = new Map()

/**
 * The icon for a catch or threat report of a given category.
 *
 * Falls back rather than throws on both axes: an unrecognised type gets the
 * catch frame, an unrecognised category gets the question mark. A pin that
 * cannot be drawn would leave a hole in the map where a real record is.
 */
export function categoryIcon(type, category) {
  const safeType = type === 'threat_report' ? 'threat_report' : 'catch'
  const safeCategory = isIconCategory(category) ? category : UNKNOWN
  const key = `${safeType}:${safeCategory}`

  let icon = cache.get(key)
  if (!icon) {
    icon = L.divIcon({
      className: `map-pin map-pin-${safeType === 'threat_report' ? 'threat' : 'catch'}-icon`,
      html: markerSvg(safeType, safeCategory),
      iconSize: [SIZE, SIZE],
      iconAnchor: [SIZE / 2, SIZE / 2],
      popupAnchor: [0, -(SIZE / 2 + 2)],
    })
    cache.set(key, icon)
  }
  return icon
}

/**
 * The same artwork, as raw markup, for the legend.
 *
 * The legend renders the real markers rather than an approximation of them, so
 * there is no second drawing of the same thing to keep in step with this one.
 */
export const legendSvg = (type, category) => markerSvg(type, category)

/** Everything the legend needs to caption itself, in display order. */
export const LEGEND_CATEGORIES = ICON_CATEGORIES
