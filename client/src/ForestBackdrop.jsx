/**
 * App-wide forest backdrop — original flat-geometry pine and ridge silhouettes.
 *
 * Four depth layers, back to front, in shades stepped between the field green
 * and the deep green of the palette. No gradients: every shape is a flat fill,
 * and depth is carried by tone and overlap alone.
 *
 * Readability
 * -----------
 * The whole scene is wrapped in a single <g opacity>. That matters more than it
 * looks: a group opacity composites the group as one unit, so two silhouettes
 * overlapping does *not* darken the page more than one does. Per-shape alpha
 * would compound, and the floor under body text would depend on how many
 * layers happened to stack at that spot.
 *
 * With one group at 13%, the darkest possible pixel behind text is the deep
 * green layer over the field green — about #B7CFA9 — which leaves the muted
 * body colour at 4.7:1 and headings at 9:1. Both clear WCAG AA. Raising
 * SCENE_OPACITY past ~0.14 drops muted text below 4.5:1, so it is a ceiling,
 * not a taste knob.
 *
 * Anchoring
 * ---------
 * `xMidYMax slice` pins the scene to the bottom of the viewport. On a wide,
 * short window the crop eats into the ridges at the top, which is the right
 * thing to lose — the treeline at the bottom is the part that reads as a
 * forest.
 */

const SCENE_OPACITY = 0.13

// Stepped between --color-field and --color-deep-green. Kept as literals rather
// than custom properties because SVG `fill` needs a resolved colour and these
// are scene geometry, not theme surface.
const LAYERS = {
  far: '#8fb98a',
  mid: '#5e9068',
  near: '#35664a',
  front: '#1a4531',
}

const VIEW_W = 1200
const VIEW_H = 900

/**
 * One pine: three stacked triangles, each wider than the one above it.
 *
 * `x` is the trunk centre and `base` the ground line, so a caller positions a
 * tree by where it stands rather than by its bounding box.
 */
function Pine({ x, base, width, height, fill, trunk = false }) {
  const w = width / 2
  const tier = (topY, spread, bottomY) =>
    `${x},${topY} ${x - w * spread},${bottomY} ${x + w * spread},${bottomY}`

  return (
    <g fill={fill}>
      <polygon points={tier(base - height, 0.52, base - height * 0.58)} />
      <polygon points={tier(base - height * 0.78, 0.76, base - height * 0.29)} />
      <polygon points={tier(base - height * 0.5, 1, base)} />
      {trunk && (
        <rect x={x - width * 0.045} y={base - height * 0.08} width={width * 0.09} height={height * 0.1} />
      )}
    </g>
  )
}

/** A row of pines along one ground line, described as [x, height] pairs. */
function PineRow({ trees, base, fill, widthRatio, trunk }) {
  return trees.map(([x, height], i) => (
    <Pine
      key={i}
      x={x}
      base={base}
      width={height * widthRatio}
      height={height}
      fill={fill}
      trunk={trunk}
    />
  ))
}

// Ridgelines as closed polygons: an angular crest, then straight down and back
// along the bottom of the viewBox so the fill has a body under it.
const ridge = (points) => `${points} ${VIEW_W},${VIEW_H} 0,${VIEW_H}`

export default function ForestBackdrop() {
  return (
    <div className="forest-backdrop" aria-hidden="true">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMax slice"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
      >
        <g opacity={SCENE_OPACITY}>
          {/* Layer 1 — distant ridgeline. */}
          <polygon
            fill={LAYERS.far}
            points={ridge('0,352 148,246 268,318 402,180 534,300 668,214 812,330 944,238 1076,326 1200,262')}
          />

          {/* Layer 2 — second ridge, with a thin treeline standing on its crest
              so the two ridges do not read as flat paper cutouts. */}
          <polygon
            fill={LAYERS.mid}
            points={ridge('0,486 132,414 256,470 388,388 512,458 646,396 782,470 918,404 1052,468 1200,410')}
          />
          <PineRow
            fill={LAYERS.mid}
            base={470}
            widthRatio={0.62}
            trees={[
              [78, 62],
              [196, 48],
              [330, 70],
              [452, 52],
              [588, 64],
              [714, 46],
              [858, 68],
              [986, 50],
              [1124, 60],
            ]}
          />

          {/* Layer 3 — mid-ground stand. */}
          <polygon fill={LAYERS.near} points={ridge('0,660 1200,660')} />
          <PineRow
            fill={LAYERS.near}
            base={668}
            widthRatio={0.66}
            trees={[
              [46, 132],
              [168, 168],
              [292, 118],
              [408, 156],
              [546, 138],
              [668, 176],
              [796, 124],
              [918, 162],
              [1042, 132],
              [1166, 170],
            ]}
          />

          {/* Layer 4 — foreground stand, darkest and tallest, running off the
              bottom of the frame. */}
          <PineRow
            fill={LAYERS.front}
            base={VIEW_H}
            widthRatio={0.7}
            trunk
            trees={[
              [-10, 236],
              [124, 288],
              [262, 214],
              [386, 268],
              [520, 230],
              [652, 296],
              [790, 222],
              [922, 274],
              [1058, 234],
              [1196, 286],
            ]}
          />
        </g>
      </svg>
    </div>
  )
}
