// A real rarity score for a catch: place-scoped iNaturalist observation
// count + conservation status, equally weighted when both are available.
//
// Replaces catches.rarity, which held Math.random() over five letter grades
// (see migration 006 and routes/api.js's old VALID_RARITIES pick) — noise,
// not a signal. Every constant below was checked against real API responses
// for the species already in the live catches table before being chosen;
// see docs/rarity-scoring-plan-20260817.md for the investigation and the
// real numbers this was built from. Cutoffs are explicitly PROVISIONAL —
// flagged as such at every point they're used — pending a look at real score
// distribution once more (and more geographically varied) catches exist.

// Observations score
// -------------------
// Log-scale and inverted: common species have huge counts, rare ones have
// small ones, and the difference between 5 and 50 observations matters a lot
// more than the difference between 50,000 and 50,050 — a linear scale would
// let a handful of ultra-common species swallow the whole range.
//
// 10,000 is the "definitely common" cap. Not a guess: every species in the
// live catches table that reads as common — regardless of it being a
// dominant native (Douglas-fir, 11,079 in Oregon), an iconic desert plant
// (saguaro, 83,804 in Arizona), or a common invasive weed (Scotch broom,
// 5,543 in Oregon) — already sits at or past this cap. Genuine rarities in
// the same table (a Mexican-endemic cactus logged against Arizona: 0; a
// banana photographed in Oregon: 5) sit far below it. See the plan doc's
// §2/§5 for the full real-data table this was checked against.
const OBSERVATIONS_CAP = 10_000

/**
 * @param {number|null|undefined} placeScopedCount from
 *   getPlaceScopedObservationCount() — NOT getTaxonStatus().observationCount,
 *   which is global. See inaturalist.js's comments on both.
 * @returns {number} 0 (definitely common) – 1 (no/near-no local record)
 */
export function observationsScore(placeScopedCount) {
  const n = Math.max(0, Number(placeScopedCount) || 0)
  const raw = 1 - Math.log10(n + 1) / Math.log10(OBSERVATIONS_CAP + 1)
  return Math.min(1, Math.max(0, raw))
}

// Conservation score
// -------------------
// iNaturalist normalizes every authority it tracks (IUCN, CNPS, USFWS, state
// agencies, ...) onto the same 0/10/20/30/40/50/60/70 ordinal, exposed as
// `iucn` on a taxon's conservation_status. Confirmed against real
// assessments from four different authorities (see the plan doc §2) — this
// is iNaturalist's own normalization, not a status-string lookup table this
// codebase would otherwise have to hand-build and maintain across every
// authority's own vocabulary.
const IUCN_MAX = 70

/**
 * @param {number|null|undefined} iucn from
 *   getTaxonStatus().conservationStatus?.iucn — null/undefined means "no
 *   real assessment", scored as null (not 0), so callers can tell "not
 *   threatened" apart from "not evaluated".
 * @returns {number|null}
 */
export function conservationScore(iucn) {
  if (iucn == null) return null
  return Math.min(1, Math.max(0, Number(iucn) / IUCN_MAX))
}

// Bands — PROVISIONAL, per the task brief. Checked against the 16 real
// species live in `catches` today (all lacking conservation data, the
// confirmed majority case): 9 Common, 1 Uncommon, 1 Rare, 5 Very Rare — all
// four bands hit, no single-band clustering, but from one small demo
// dataset. Revisit after backfill (more, and more geographically varied,
// real rows) produces a bigger sample.
const BANDS = [
  [0.3, 'Common'],
  [0.55, 'Uncommon'],
  [0.75, 'Rare'],
]
const HIGHEST_BAND = 'Very Rare'

/** @param {number} score @returns {string} */
export function bandFor(score) {
  for (const [ceiling, label] of BANDS) {
    if (score < ceiling) return label
  }
  return HIGHEST_BAND
}

// Gacha tier — PlantCard.jsx's existing N/R/SR/SSR/UR scale (real CSS colors
// already built, see client/src/css/PlantCard.css). A SEPARATE presentation
// of the same rarity_score from the 4-band `bandFor()` above, not the same
// scale re-labeled — see the plan doc §7 for why these are deliberately two
// different cut counts.
//
// UR is reserved for score >= 0.90, on purpose: in the live table, UR would
// otherwise be the single most common tier (4 of 16 species), because
// several existing catches are demo/test rows logged against the wrong
// place entirely (a Sonoran cactus caught in "Oregon", a Mexican-endemic
// cactus caught in "Arizona") and score as maximally rare for having zero
// real local observations. That is real API behavior, correctly computed —
// but it means the live distribution is skewed rarer than real, correctly-
// located usage would be. A tighter UR cutoff keeps the top gacha tier
// meaning "exceptional", not "somebody's test photo."
const GACHA_TIERS = [
  [0.3, 'N'],
  [0.5, 'R'],
  [0.7, 'SR'],
  [0.9, 'SSR'],
]
const HIGHEST_GACHA_TIER = 'UR'

/** @param {number} score @returns {'N'|'R'|'SR'|'SSR'|'UR'} */
export function gachaTierFor(score) {
  for (const [ceiling, tier] of GACHA_TIERS) {
    if (score < ceiling) return tier
  }
  return HIGHEST_GACHA_TIER
}

/**
 * The combined score: 50/50 average of both components when iNaturalist has
 * a real conservation assessment, observations alone at full weight when it
 * doesn't (today's majority case — 0 of 16 live species have one).
 *
 * @param {{ observationsCount: number|null, conservationIucn: number|null }} input
 * @returns {{ score: number, band: string, gachaTier: string }}
 */
export function computeRarity({ observationsCount, conservationIucn }) {
  const obs = observationsScore(observationsCount)
  const cons = conservationScore(conservationIucn)
  const score = Number((cons == null ? obs : (obs + cons) / 2).toFixed(3))
  return { score, band: bandFor(score), gachaTier: gachaTierFor(score) }
}
