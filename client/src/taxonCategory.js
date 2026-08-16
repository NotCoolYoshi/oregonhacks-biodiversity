/**
 * What *kind* of plant a catch is, for the sake of picking a marker icon.
 *
 * Six buckets, chosen because they are the distinctions a person can actually
 * make out at 26px on a busy map: tree, shrub, wildflower, cactus/succulent,
 * grass/fern, and an honest "unknown". This is a drawing decision, not a
 * taxonomic one — nothing downstream treats these as botany.
 *
 * ---------------------------------------------------------------------------
 * What this can read, and what it cannot
 *
 * GET /api/catches serves a projection of the `catches` table:
 *
 *     id, taxon_id, scientific_name, common_name, type, lat, lng,
 *     place_id, place_name, photo_url, created_at
 *
 * There is no rank, no family and no genus column — the table never stored
 * them (see server/src/db/schema.sql). The one piece of taxonomy on a catch row
 * is `scientific_name`, and the genus is its first word. So genus is what this
 * bucketing is built on, and it costs zero extra requests, which is the whole
 * point: a per-marker lookup of family or rank would mean one iNaturalist call
 * per pin on a map that can hold hundreds.
 *
 * The helper still reads `family`, `genus` and `rank` when a caller happens to
 * have them — the nearby-observations rows carry `rank`, and Pl@ntNet results
 * carry `genus` and `family` — because preferring better evidence when it is
 * already in hand costs one property read.
 *
 * ---------------------------------------------------------------------------
 * Why a table and not a rule
 *
 * There is no derivable relationship between a genus name and its growth form.
 * A lookup is the only honest implementation, so the failure mode is a genus
 * that is not listed, and that failure mode is `unknown` — a real bucket with
 * its own icon, not a wrong one. Adding a genus is a one-line change.
 *
 * Families are listed only where the whole family shares a growth form.
 * Fabaceae, Rosaceae and Euphorbiaceae are deliberately absent: each spans
 * trees, shrubs and herbs, and guessing from them would be worse than
 * `unknown`, which at least does not lie.
 */

export const TREE = 'tree'
export const SHRUB = 'shrub'
export const WILDFLOWER = 'wildflower'
export const CACTUS_SUCCULENT = 'cactus_succulent'
export const GRASS_FERN = 'grass_fern'
export const UNKNOWN = 'unknown'

/** Display order, used by the legend. Unknown last, where a fallback belongs. */
export const ICON_CATEGORIES = [
  { category: TREE, label: 'Tree' },
  { category: SHRUB, label: 'Shrub' },
  { category: WILDFLOWER, label: 'Wildflower' },
  { category: CACTUS_SUCCULENT, label: 'Cactus / succulent' },
  { category: GRASS_FERN, label: 'Grass / fern' },
  { category: UNKNOWN, label: 'Unidentified form' },
]

const CATEGORY_SET = new Set(ICON_CATEGORIES.map((c) => c.category))

/** True for a category string this module actually knows how to draw. */
export const isIconCategory = (value) => CATEGORY_SET.has(value)

// ---------------------------------------------------------------------------
// Lookup tables
//
// Lower case throughout; every lookup lower-cases its key first, so a row that
// arrives as "PSEUDOTSUGA MENZIESII" still lands.
// ---------------------------------------------------------------------------

/**
 * Families whose members all share one growth form.
 *
 * Consulted before genus, because a family is the stronger signal when a
 * caller has one — but almost no caller does, so in practice this table earns
 * its keep on rows identified only to family (see `rank` handling below).
 */
const FAMILY_CATEGORY = new Map(Object.entries({
  // Conifers. Every member is a tree or a tree-shaped shrub.
  pinaceae: TREE,
  cupressaceae: TREE,
  taxaceae: TREE,
  araucariaceae: TREE,
  sciadopityaceae: TREE,
  // Broadleaf families that are trees top to bottom.
  fagaceae: TREE,
  betulaceae: TREE,
  juglandaceae: TREE,
  salicaceae: TREE,
  ulmaceae: TREE,
  platanaceae: TREE,
  altingiaceae: TREE,
  arecaceae: TREE,
  ginkgoaceae: TREE,

  ericaceae: SHRUB,
  berberidaceae: SHRUB,
  grossulariaceae: SHRUB,
  caprifoliaceae: SHRUB,
  adoxaceae: SHRUB,
  rhamnaceae: SHRUB,
  hydrangeaceae: SHRUB,
  garryaceae: SHRUB,

  asteraceae: WILDFLOWER,
  ranunculaceae: WILDFLOWER,
  violaceae: WILDFLOWER,
  orchidaceae: WILDFLOWER,
  papaveraceae: WILDFLOWER,
  brassicaceae: WILDFLOWER,
  apiaceae: WILDFLOWER,
  boraginaceae: WILDFLOWER,
  onagraceae: WILDFLOWER,
  liliaceae: WILDFLOWER,
  iridaceae: WILDFLOWER,
  primulaceae: WILDFLOWER,
  caryophyllaceae: WILDFLOWER,
  plantaginaceae: WILDFLOWER,
  polemoniaceae: WILDFLOWER,
  saxifragaceae: WILDFLOWER,
  melanthiaceae: WILDFLOWER,
  orobanchaceae: WILDFLOWER,

  cactaceae: CACTUS_SUCCULENT,
  crassulaceae: CACTUS_SUCCULENT,
  aizoaceae: CACTUS_SUCCULENT,
  didiereaceae: CACTUS_SUCCULENT,
  fouquieriaceae: CACTUS_SUCCULENT,

  poaceae: GRASS_FERN,
  cyperaceae: GRASS_FERN,
  juncaceae: GRASS_FERN,
  typhaceae: GRASS_FERN,
  equisetaceae: GRASS_FERN,
  polypodiaceae: GRASS_FERN,
  dryopteridaceae: GRASS_FERN,
  pteridaceae: GRASS_FERN,
  athyriaceae: GRASS_FERN,
  blechnaceae: GRASS_FERN,
  dennstaedtiaceae: GRASS_FERN,
  aspleniaceae: GRASS_FERN,
  osmundaceae: GRASS_FERN,
  cystopteridaceae: GRASS_FERN,
  woodsiaceae: GRASS_FERN,
  thelypteridaceae: GRASS_FERN,
  selaginellaceae: GRASS_FERN,
}))

/**
 * Genus to growth form.
 *
 * Weighted towards what this app actually sees: Pacific Northwest natives, the
 * invasives that get reported as threats, the desert flora that turns up in the
 * Arizona rows, and the garden escapes common enough to be photographed
 * anywhere. It is not, and is not trying to be, a flora.
 *
 * Where a genus genuinely straddles two forms the more commonly observed one
 * wins, since the alternative is `unknown` for a genus we can mostly place.
 */
const GENUS_CATEGORY = new Map(Object.entries({
  // --- Trees ---------------------------------------------------------------
  abies: TREE, acacia: TREE, acer: TREE, aesculus: TREE, ailanthus: TREE,
  albizia: TREE, alnus: TREE, arbutus: TREE, betula: TREE, calocedrus: TREE,
  carpinus: TREE, carya: TREE, castanea: TREE, casuarina: TREE, catalpa: TREE,
  cedrus: TREE, celtis: TREE, cercis: TREE, chamaecyparis: TREE,
  chilopsis: TREE, cinnamomum: TREE, citrus: TREE, cornus: TREE,
  corylus: TREE, crataegus: TREE, cryptomeria: TREE, cupressus: TREE,
  eucalyptus: TREE, fagus: TREE, ficus: TREE, fraxinus: TREE, ginkgo: TREE,
  gleditsia: TREE, ilex: TREE, jacaranda: TREE, juglans: TREE,
  juniperus: TREE, koelreuteria: TREE, larix: TREE, laurus: TREE,
  liquidambar: TREE, liriodendron: TREE, magnolia: TREE, malus: TREE,
  melaleuca: TREE, metasequoia: TREE, morus: TREE, nyssa: TREE, olea: TREE,
  olneya: TREE, parkinsonia: TREE, paulownia: TREE, persea: TREE,
  phoenix: TREE, picea: TREE, pinus: TREE, pistacia: TREE, platanus: TREE,
  populus: TREE, prosopis: TREE, prunus: TREE, pseudotsuga: TREE,
  pyrus: TREE, quercus: TREE, robinia: TREE, salix: TREE, schinus: TREE,
  sequoia: TREE, sequoiadendron: TREE, sorbus: TREE, taxodium: TREE,
  taxus: TREE, thuja: TREE, tilia: TREE, triadica: TREE, tsuga: TREE,
  ulmus: TREE, umbellularia: TREE, washingtonia: TREE, zelkova: TREE,

  // --- Shrubs --------------------------------------------------------------
  amelanchier: SHRUB, arctostaphylos: SHRUB, artemisia: SHRUB,
  atriplex: SHRUB, baccharis: SHRUB, berberis: SHRUB, buddleja: SHRUB,
  buxus: SHRUB, callistemon: SHRUB, calluna: SHRUB, camellia: SHRUB,
  ceanothus: SHRUB, cercocarpus: SHRUB, chrysothamnus: SHRUB, cistus: SHRUB,
  cotoneaster: SHRUB, cytisus: SHRUB, daphne: SHRUB, elaeagnus: SHRUB,
  encelia: SHRUB, ericameria: SHRUB, erica: SHRUB, escallonia: SHRUB,
  euonymus: SHRUB, forsythia: SHRUB, frangula: SHRUB, gaultheria: SHRUB,
  genista: SHRUB, grevillea: SHRUB, hedera: SHRUB, holodiscus: SHRUB,
  hydrangea: SHRUB, hypericum: SHRUB, kalmia: SHRUB, larrea: SHRUB,
  lavandula: SHRUB, ledum: SHRUB, ligustrum: SHRUB, lonicera: SHRUB,
  mahonia: SHRUB, menziesia: SHRUB, myrica: SHRUB, nandina: SHRUB,
  nerium: SHRUB, oemleria: SHRUB, oplopanax: SHRUB, philadelphus: SHRUB,
  photinia: SHRUB, physocarpus: SHRUB, pieris: SHRUB, purshia: SHRUB,
  pyracantha: SHRUB, rhamnus: SHRUB, rhododendron: SHRUB, rhus: SHRUB,
  ribes: SHRUB, rosa: SHRUB, rosmarinus: SHRUB, rubus: SHRUB,
  sambucus: SHRUB, sarcococca: SHRUB, simmondsia: SHRUB, spiraea: SHRUB,
  symphoricarpos: SHRUB, syringa: SHRUB, toxicodendron: SHRUB, ulex: SHRUB,
  vaccinium: SHRUB, viburnum: SHRUB, weigela: SHRUB,

  // --- Wildflowers (herbaceous forbs) --------------------------------------
  achillea: WILDFLOWER, achlys: WILDFLOWER, aconitum: WILDFLOWER,
  allium: WILDFLOWER, ambrosia: WILDFLOWER, amsinckia: WILDFLOWER,
  anaphalis: WILDFLOWER, anemone: WILDFLOWER, anthemis: WILDFLOWER,
  aquilegia: WILDFLOWER, arnica: WILDFLOWER, asarum: WILDFLOWER,
  aster: WILDFLOWER, balsamorhiza: WILDFLOWER, brassica: WILDFLOWER,
  brodiaea: WILDFLOWER, calochortus: WILDFLOWER, caltha: WILDFLOWER,
  camassia: WILDFLOWER, campanula: WILDFLOWER, capsella: WILDFLOWER,
  cardamine: WILDFLOWER, castilleja: WILDFLOWER, centaurea: WILDFLOWER,
  cerastium: WILDFLOWER, chamerion: WILDFLOWER, chenopodium: WILDFLOWER,
  cichorium: WILDFLOWER, cirsium: WILDFLOWER, clarkia: WILDFLOWER,
  claytonia: WILDFLOWER, collinsia: WILDFLOWER, conium: WILDFLOWER,
  convolvulus: WILDFLOWER, coreopsis: WILDFLOWER, corydalis: WILDFLOWER,
  daucus: WILDFLOWER, delphinium: WILDFLOWER, dianthus: WILDFLOWER,
  dicentra: WILDFLOWER, digitalis: WILDFLOWER, dodecatheon: WILDFLOWER,
  epilobium: WILDFLOWER, erigeron: WILDFLOWER, eriogonum: WILDFLOWER,
  erodium: WILDFLOWER, erythranthe: WILDFLOWER, erythronium: WILDFLOWER,
  eschscholzia: WILDFLOWER, foeniculum: WILDFLOWER, fragaria: WILDFLOWER,
  fritillaria: WILDFLOWER, gaillardia: WILDFLOWER, galium: WILDFLOWER,
  geranium: WILDFLOWER, geum: WILDFLOWER, helianthus: WILDFLOWER,
  heracleum: WILDFLOWER, hesperis: WILDFLOWER, heuchera: WILDFLOWER,
  hieracium: WILDFLOWER, hypochaeris: WILDFLOWER, impatiens: WILDFLOWER,
  iris: WILDFLOWER, lactuca: WILDFLOWER, lamium: WILDFLOWER,
  lathyrus: WILDFLOWER, leucanthemum: WILDFLOWER, lilium: WILDFLOWER,
  linaria: WILDFLOWER, linnaea: WILDFLOWER, lotus: WILDFLOWER,
  lupinus: WILDFLOWER, lysichiton: WILDFLOWER, maianthemum: WILDFLOWER,
  malva: WILDFLOWER, matricaria: WILDFLOWER, medicago: WILDFLOWER,
  melilotus: WILDFLOWER, mentha: WILDFLOWER, mimulus: WILDFLOWER,
  monarda: WILDFLOWER, montia: WILDFLOWER, myosotis: WILDFLOWER,
  nemophila: WILDFLOWER, oenothera: WILDFLOWER, origanum: WILDFLOWER,
  osmorhiza: WILDFLOWER, oxalis: WILDFLOWER, papaver: WILDFLOWER,
  penstemon: WILDFLOWER, persicaria: WILDFLOWER, petasites: WILDFLOWER,
  phacelia: WILDFLOWER, plantago: WILDFLOWER, polygonum: WILDFLOWER,
  potentilla: WILDFLOWER, prunella: WILDFLOWER, pyrola: WILDFLOWER,
  ranunculus: WILDFLOWER, raphanus: WILDFLOWER, rumex: WILDFLOWER,
  salvia: WILDFLOWER, sanguisorba: WILDFLOWER, saxifraga: WILDFLOWER,
  scutellaria: WILDFLOWER, senecio: WILDFLOWER, sidalcea: WILDFLOWER,
  silene: WILDFLOWER, sinapis: WILDFLOWER, sisyrinchium: WILDFLOWER,
  solidago: WILDFLOWER, sonchus: WILDFLOWER, stellaria: WILDFLOWER,
  streptopus: WILDFLOWER, symphyotrichum: WILDFLOWER, tanacetum: WILDFLOWER,
  taraxacum: WILDFLOWER, tellima: WILDFLOWER, thalictrum: WILDFLOWER,
  thymus: WILDFLOWER, tiarella: WILDFLOWER, tolmiea: WILDFLOWER,
  toxicoscordion: WILDFLOWER, tragopogon: WILDFLOWER, trifolium: WILDFLOWER,
  trillium: WILDFLOWER, urtica: WILDFLOWER, vancouveria: WILDFLOWER,
  verbascum: WILDFLOWER, verbena: WILDFLOWER, veronica: WILDFLOWER,
  vicia: WILDFLOWER, viola: WILDFLOWER, xerophyllum: WILDFLOWER,

  // --- Cacti and succulents ------------------------------------------------
  adenium: CACTUS_SUCCULENT, aeonium: CACTUS_SUCCULENT, agave: CACTUS_SUCCULENT,
  aloe: CACTUS_SUCCULENT, carnegiea: CACTUS_SUCCULENT,
  carpobrotus: CACTUS_SUCCULENT, cereus: CACTUS_SUCCULENT,
  crassula: CACTUS_SUCCULENT, cylindropuntia: CACTUS_SUCCULENT,
  dasylirion: CACTUS_SUCCULENT, delosperma: CACTUS_SUCCULENT,
  dudleya: CACTUS_SUCCULENT, echeveria: CACTUS_SUCCULENT,
  echinocactus: CACTUS_SUCCULENT, echinocereus: CACTUS_SUCCULENT,
  ferocactus: CACTUS_SUCCULENT, fouquieria: CACTUS_SUCCULENT,
  graptopetalum: CACTUS_SUCCULENT, haworthia: CACTUS_SUCCULENT,
  hesperoyucca: CACTUS_SUCCULENT, hylocereus: CACTUS_SUCCULENT,
  kalanchoe: CACTUS_SUCCULENT, lithops: CACTUS_SUCCULENT,
  lophocereus: CACTUS_SUCCULENT, mammillaria: CACTUS_SUCCULENT,
  nolina: CACTUS_SUCCULENT, opuntia: CACTUS_SUCCULENT,
  pachycereus: CACTUS_SUCCULENT, parodia: CACTUS_SUCCULENT,
  pereskia: CACTUS_SUCCULENT, portulaca: CACTUS_SUCCULENT,
  schlumbergera: CACTUS_SUCCULENT, sedum: CACTUS_SUCCULENT,
  sempervivum: CACTUS_SUCCULENT, stenocereus: CACTUS_SUCCULENT,
  yucca: CACTUS_SUCCULENT,

  // --- Grasses, sedges, rushes, ferns and horsetails ------------------------
  adiantum: GRASS_FERN, agrostis: GRASS_FERN, ammophila: GRASS_FERN,
  andropogon: GRASS_FERN, arrhenatherum: GRASS_FERN, asplenium: GRASS_FERN,
  athyrium: GRASS_FERN, avena: GRASS_FERN, azolla: GRASS_FERN,
  bambusa: GRASS_FERN, blechnum: GRASS_FERN, bolboschoenus: GRASS_FERN,
  bouteloua: GRASS_FERN, bromus: GRASS_FERN, calamagrostis: GRASS_FERN,
  carex: GRASS_FERN, cortaderia: GRASS_FERN, cynodon: GRASS_FERN,
  cystopteris: GRASS_FERN, dactylis: GRASS_FERN, danthonia: GRASS_FERN,
  deschampsia: GRASS_FERN, distichlis: GRASS_FERN, dryopteris: GRASS_FERN,
  eleocharis: GRASS_FERN, elymus: GRASS_FERN, equisetum: GRASS_FERN,
  eragrostis: GRASS_FERN, festuca: GRASS_FERN, glyceria: GRASS_FERN,
  gymnocarpium: GRASS_FERN, holcus: GRASS_FERN, hordeum: GRASS_FERN,
  juncus: GRASS_FERN, koeleria: GRASS_FERN, lolium: GRASS_FERN,
  luzula: GRASS_FERN, matteuccia: GRASS_FERN, melica: GRASS_FERN,
  muhlenbergia: GRASS_FERN, nassella: GRASS_FERN, onoclea: GRASS_FERN,
  osmunda: GRASS_FERN, panicum: GRASS_FERN, pennisetum: GRASS_FERN,
  pentagramma: GRASS_FERN, phalaris: GRASS_FERN, phegopteris: GRASS_FERN,
  phleum: GRASS_FERN, phragmites: GRASS_FERN, phyllostachys: GRASS_FERN,
  poa: GRASS_FERN, polypodium: GRASS_FERN, polystichum: GRASS_FERN,
  pteridium: GRASS_FERN, salvinia: GRASS_FERN, schizachyrium: GRASS_FERN,
  schoenoplectus: GRASS_FERN, scirpus: GRASS_FERN, selaginella: GRASS_FERN,
  setaria: GRASS_FERN, sorghum: GRASS_FERN, spartina: GRASS_FERN,
  sporobolus: GRASS_FERN, stipa: GRASS_FERN, struthiopteris: GRASS_FERN,
  trisetum: GRASS_FERN, typha: GRASS_FERN, woodsia: GRASS_FERN,
  woodwardia: GRASS_FERN,
}))

/**
 * Species whose genus says the wrong thing.
 *
 * Kept deliberately short. A genus only earns an entry here when it is both
 * genuinely split between two forms *and* has members common enough to be
 * photographed — otherwise the genus table is the right place.
 *
 * Euphorbia is the whole reason this table exists: most spurges are weedy
 * herbs, but the ones people plant and photograph are stem succulents that look
 * nothing like them. The genus is filed as a wildflower and the succulents are
 * named here.
 */
const SPECIES_CATEGORY = new Map(Object.entries({
  'euphorbia tirucalli': CACTUS_SUCCULENT,
  'euphorbia milii': CACTUS_SUCCULENT,
  'euphorbia trigona': CACTUS_SUCCULENT,
  'euphorbia lactea': CACTUS_SUCCULENT,
  'euphorbia ingens': CACTUS_SUCCULENT,
  'euphorbia candelabrum': CACTUS_SUCCULENT,
  'euphorbia obesa': CACTUS_SUCCULENT,
  'euphorbia tithymaloides': CACTUS_SUCCULENT,
  'euphorbia myrsinites': CACTUS_SUCCULENT,
}))

// Euphorbia itself: the weedy herbs outnumber the succulents in the wild, so
// the genus goes to wildflower and SPECIES_CATEGORY handles the exceptions.
GENUS_CATEGORY.set('euphorbia', WILDFLOWER)

// ---------------------------------------------------------------------------

const clean = (value) => String(value ?? '').trim().toLowerCase()

/**
 * The genus out of a scientific name.
 *
 * Just the first word: "Pseudotsuga menziesii" -> "pseudotsuga". A bare genus
 * name ("Rubus") is its own genus, which is why there is no word-count check —
 * a name identified no further than genus should still get a shrub icon.
 *
 * Returns '' for anything that is not a plausible genus, including the hybrid
 * marker "×" and the placeholder names iNaturalist uses for unplaced taxa.
 */
function genusOf(scientificName) {
  const first = clean(scientificName).split(/\s+/)[0] ?? ''
  return /^[a-z][a-z-]{2,}$/.test(first) ? first : ''
}

/**
 * Plant family names all end -aceae, and no genus name does. That one suffix
 * is enough to tell "identified only to family" from "identified to a genus"
 * without consulting `rank` at all — which matters, because the catch rows this
 * mostly runs on have no rank to consult.
 */
const looksLikeFamily = (name) => name.endsWith('aceae')

/**
 * Which icon a taxon gets.
 *
 * Accepts anything with a name on it, in either of the two casings this
 * codebase speaks — catch rows are snake_case from the database, observation
 * rows are camelCase from the nearby route:
 *
 *     { scientific_name: 'Acer macrophyllum' }      -> 'tree'
 *     { scientificName: 'Opuntia', rank: 'genus' }  -> 'cactus_succulent'
 *     { scientificName: 'Poaceae', rank: 'family' } -> 'grass_fern'
 *     { genus: 'Rubus', family: 'Rosaceae' }        -> 'shrub'
 *     { scientific_name: 'Zzyzx nonesuch' }         -> 'unknown'
 *     null                                          -> 'unknown'
 *
 * Never throws and never returns anything outside ICON_CATEGORIES: a marker
 * that cannot be drawn is worse than a marker drawn vaguely.
 */
export function taxonToIconCategory(taxon) {
  if (!taxon || typeof taxon !== 'object') return UNKNOWN

  const scientificName = clean(taxon.scientificName ?? taxon.scientific_name)

  // Best evidence first: an exact species this module has an opinion about,
  // because its genus would give the wrong answer.
  const species = SPECIES_CATEGORY.get(scientificName)
  if (species) return species

  // A family named outright, by a caller that has one.
  const family = FAMILY_CATEGORY.get(clean(taxon.family))
  if (family) return family

  // Otherwise the first word of the name: the genus, or the family itself when
  // the identification never got as far as a genus.
  const leading = clean(taxon.genus) || genusOf(scientificName)
  if (looksLikeFamily(leading)) return FAMILY_CATEGORY.get(leading) ?? UNKNOWN

  return GENUS_CATEGORY.get(leading) ?? UNKNOWN
}
