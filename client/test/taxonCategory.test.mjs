// Checks that taxonToIconCategory buckets what this app actually sees, and that
// it fails to `unknown` rather than to a wrong icon.
//
// The point is not coverage of the lookup tables — they are data, and asserting
// a table against itself proves nothing. The point is the three things that can
// break silently:
//
//   1. every taxon in the live catch data gets a *correct* icon, not just a
//      non-crashing one — a Douglas-fir drawn as a wildflower is worse than one
//      drawn as a question mark;
//   2. both casings the codebase speaks are read, since catch rows are
//      snake_case and observation rows are camelCase, and a helper that only
//      handled one would silently draw every marker on one layer as unknown;
//   3. nothing outside the six drawable categories can ever come out.

import {
  taxonToIconCategory,
  isIconCategory,
  ICON_CATEGORIES,
  TREE,
  SHRUB,
  WILDFLOWER,
  CACTUS_SUCCULENT,
  GRASS_FERN,
  UNKNOWN,
} from '../src/taxonCategory.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

const categoryOf = (scientific_name) => taxonToIconCategory({ scientific_name })

// ---------------------------------------------------------------------------
// Every distinct taxon in the live catches table, on 2026-08-16, with the icon
// a botanist would give it. Read from GET /api/catches against production data
// rather than invented, so this is the real spot check and not a rehearsal of
// one.
// ---------------------------------------------------------------------------
const PRODUCTION_TAXA = [
  ['Pseudotsuga menziesii', TREE],             // Douglas-fir
  ['Acer macrophyllum', TREE],                 // bigleaf maple
  ['Parkinsonia aculeata', TREE],              // Mexican palo verde
  ['Pistacia atlantica', TREE],                // Mt Atlas mastic (threat)
  ['Berberis aquifolium', SHRUB],              // Oregon grape
  ['Cytisus scoparius', SHRUB],                // Scotch broom (threat)
  ['Rubus armeniacus', SHRUB],                 // Armenian blackberry (threat)
  ['Euphorbia tirucalli', CACTUS_SUCCULENT],   // fire stick — a succulent spurge
]

console.log('\n-- every taxon in the live catch data --')
for (const [name, expected] of PRODUCTION_TAXA) {
  const got = categoryOf(name)
  check(`${name} -> ${expected}`, got === expected, `got ${got}`)
}
check('no live taxon falls through to unknown',
  PRODUCTION_TAXA.every(([name]) => categoryOf(name) !== UNKNOWN))

console.log('\n-- the two casings this codebase speaks --')
check('a catch row (snake_case) is read',
  taxonToIconCategory({ scientific_name: 'Quercus garryana' }) === TREE)
check('an observation row (camelCase) is read',
  taxonToIconCategory({ scientificName: 'Quercus garryana' }) === TREE)
check('a Pl@ntNet-shaped result with a genus is read',
  taxonToIconCategory({ genus: 'Rubus', family: 'Rosaceae' }) === SHRUB)

console.log('\n-- identifications short of a species --')
check('a bare genus still gets its genus icon',
  taxonToIconCategory({ scientificName: 'Opuntia', rank: 'genus' }) === CACTUS_SUCCULENT)
check('a family-level identification uses the family table',
  taxonToIconCategory({ scientificName: 'Poaceae', rank: 'family' }) === GRASS_FERN)
check('a family name is not looked up as a genus',
  taxonToIconCategory({ scientificName: 'Pinaceae' }) === TREE)
check('an unlisted family is unknown, not guessed',
  taxonToIconCategory({ scientificName: 'Zzyzxaceae', rank: 'family' }) === UNKNOWN)

console.log('\n-- a genus that would lie is overridden by species --')
// Euphorbia is filed as a wildflower because most spurges are weeds; the
// succulent members have to beat their own genus or they get a flower icon.
check('a weedy spurge is a wildflower', categoryOf('Euphorbia peplus') === WILDFLOWER)
check('a succulent spurge is not', categoryOf('Euphorbia tirucalli') === CACTUS_SUCCULENT)
check('the override is species-specific, not genus-wide',
  categoryOf('Euphorbia') === WILDFLOWER)

console.log('\n-- families deliberately left out rather than guessed --')
// Fabaceae and Rosaceae each span trees, shrubs and herbs. Mapping them would
// be worse than unknown, so the genus must be what decides.
check('a Rosaceae tree is a tree', categoryOf('Prunus emarginata') === TREE)
check('a Rosaceae shrub is a shrub', categoryOf('Rubus spectabilis') === SHRUB)
check('a Rosaceae herb is a wildflower', categoryOf('Fragaria vesca') === WILDFLOWER)
check('a Fabaceae tree is a tree', categoryOf('Robinia pseudoacacia') === TREE)
check('a Fabaceae herb is a wildflower', categoryOf('Lupinus polyphyllus') === WILDFLOWER)
check('an unlisted Rosaceae genus is unknown, not "probably a shrub"',
  taxonToIconCategory({ scientific_name: 'Kerria japonica', family: 'Rosaceae' }) === UNKNOWN)

console.log('\n-- junk in, unknown out --')
const JUNK = [
  null,
  undefined,
  {},
  'Acer macrophyllum',            // a string, not a row
  { scientific_name: '' },
  { scientific_name: '   ' },
  { scientific_name: 123 },
  { scientific_name: '×Dactylodenia' },
  { scientific_name: 'Zzyzx nonesuch' },
]
for (const input of JUNK) {
  const got = taxonToIconCategory(input)
  check(`${JSON.stringify(input) ?? String(input)} -> unknown`, got === UNKNOWN, `got ${got}`)
}

console.log('\n-- the result is always drawable --')
const SAMPLES = [
  ...PRODUCTION_TAXA.map(([name]) => ({ scientific_name: name })),
  ...JUNK,
  { scientificName: 'POACEAE', rank: 'FAMILY' },
  { scientific_name: '  pseudotsuga MENZIESII  ' },
]
check('every sample lands in a category the icon set can draw',
  SAMPLES.every((input) => isIconCategory(taxonToIconCategory(input))))
check('casing and padding do not change the answer',
  taxonToIconCategory({ scientific_name: '  pseudotsuga MENZIESII  ' }) === TREE)
check('the legend lists exactly the six drawable categories',
  ICON_CATEGORIES.length === 6 &&
    new Set(ICON_CATEGORIES.map((c) => c.category)).size === 6 &&
    ICON_CATEGORIES.every((c) => c.label),
  JSON.stringify(ICON_CATEGORIES.map((c) => c.category)))
check('unknown is last, where a fallback belongs',
  ICON_CATEGORIES.at(-1).category === UNKNOWN)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
