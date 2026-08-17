# Real Rarity Scoring — Investigation & Plan (2026-08-17)

Read-only investigation. Live Supabase project (`mlompmdbanhrbvuwcmth`) and the
real iNaturalist API were both queried to ground this plan in real numbers.
**Nothing was written** to the database, no migration was run, no code was
changed, no commit was made. PR #6 / xinyunlong's work was not touched.

---

## 0. Headline finding, before anything else: `catches.rarity` doesn't exist live

This matters for the plan below, so it's first, not buried.

I queried the live REST schema two independent ways (a direct `select` for
`rarity`, and the PostgREST OpenAPI/swagger definition for `catches`). Both
agree: **the live `catches` table has no `rarity` column at all.** `family`
is there (migration 004 landed), `sightings` exists with every column
(migration 005 landed), but migration 006 (`add column if not exists rarity
text`) was never actually run against this project — confirming the v2
audit's §1a flag was more than theoretical.

Concretely, right now, against the live DB:
- `GET /catches` (`routes/api.js:964-966`) explicitly selects `rarity` →
  this query 42703s ("column catches.rarity does not exist"). I reproduced
  this directly.
- `POST /catches`'s insert (`routes/api.js:793-809`) writes `rarity:
  VALID_RARITIES[...]` on every new catalogue row → the same column should
  make that insert fail too, by the same mechanism.

Oddly, the newest row in the table (`Musa acuminata`, `06:49 UTC` today) was
inserted **after** commit `2e1bf98` ("rarity random", `04:33 UTC`) landed on
a branch that's already merged into `origin/main`. I did not run a live
`POST /catches` to chase this down further — deliberately, to avoid writing
a throwaway row into real demo data — so I can't fully explain the
discrepancy. Possibilities: the deployed backend isn't running current
`main` yet, or that particular insert took the "repeat catch" branch (which
only writes `sightings`, not `catches`, and wouldn't touch `rarity` at all —
plausible if it was a same-user repeat). Either way: **before building
anything on top of this, do a 30-second live check** — one real capture
through the actual running app — to confirm whether `POST /catches` is
currently 500ing for new species. If it is, that's a sharper, pre-existing
bug independent of this task and worth its own fix.

**Recommendation:** don't resurrect migration 006. It's the wrong shape
anyway (a bare `text` column with no computation behind it). Retire it —
and un-do `schema.sql`'s premature inclusion of `rarity text` (added in the
same commit, per the v2 audit's §1a) — in favor of a fresh migration 007
that adds the columns this plan actually needs (§4). Two migrations
touching the same never-shipped column would just compound the confusion
the audit already flagged.

---

## 1. What `inaturalist.js` already fetches

Read `server/src/services/inaturalist.js` in full. Relevant to this task:

**`getTaxonStatus(taxonId, placeId)` (line 423)** — called once per capture,
already, from `POST /catches` (`routes/api.js:725`) to decide catch vs.
threat-report. It already calls `GET /taxa/:id?place_id=X` and already
returns:
- `conservationStatus` — via `mapConservationStatus()` (line 226), which
  reads `taxon.conservation_status` (the place-resolved single assessment,
  confirmed below) and returns `{ status, statusName, authority }`.
  **It drops the `iucn` field iNaturalist also puts on that object** — see
  §2, that field turns out to be exactly the ordinal scale the task asked
  me to build by hand.
- `observationCount` — `taxon.observations_count ?? 0`. **This is global,
  not place-scoped** — confirmed empirically in §2, not assumed. Passing
  `place_id` to `/taxa/:id` does correctly scope `conservation_status` and
  `establishment_means`, but has zero effect on `observations_count`; it's
  the same number with or without the param.

**So:** conservation status needs **no new API call** — it's already fetched
and place-scoped correctly, just needs one more field (`iucn`) threaded
through. Place-scoped observation count needs **one new call**:
`GET /observations/species_counts?place_id=X&taxon_id=Y` (confirmed working
below, and already used elsewhere in this same file by
`getNearbySpecies()`, so it's a proven pattern, not a new integration).

---

## 2. Real API responses — 16 real species, real place scoping, real conservation data

Pulled the live `catches` table (read-only; 21 rows, 16 distinct taxa across
4 real `place_id`s: 10=Oregon, 40=Arizona, 14=California, 962=Lane County
OR) and hit the real iNaturalist API for each one, place-scoped to the same
`place_id` the row was actually caught in.

### Place-scoped observation counts (`GET /observations/species_counts`)

| Species | Place | Place-scoped count | Global count |
|---|---|---:|---:|
| Carnegiea gigantea (saguaro) | Arizona | 83,804 | 86,470 |
| Pseudotsuga menziesii (Douglas-fir) | Oregon | 11,079 | 88,787 |
| Acer macrophyllum (bigleaf maple) | Oregon | 7,033 | — |
| Cytisus scoparius (Scotch broom) | Oregon | 5,543 | — |
| Rubus armeniacus (Armenian blackberry) | Oregon | 2,866 | 38,151 |
| Ligustrum japonicum (privet) | California | 2,498 | — |
| Parkinsonia aculeata (Mexican palo verde) | Arizona | 1,681 | 27,675 |
| Euphorbia tirucalli (Fire Stick) | Arizona | 839 | — |
| Dracaena fragrans | California | 665 | — |
| Berberis aquifolium (Oregon grape) | Lane County, OR | 190 | 68,846 |
| Pistacia atlantica | Arizona | 27 | — |
| Musa acuminata (Cavendish banana) | Oregon | 5 | — |
| Cylindropuntia bigelovii (teddybear cholla) | Oregon* | 0 | — |
| Lilium candidum (Madonna lily) | Oregon | 0 | — |
| Rosa × odorata (Tea Rose) | Arizona | 0 | — |
| Coryphantha cornifera | Arizona† | 0 | 198 |

\* This one's real row has `place_id=10` (Oregon) for a species that's
actually a Sonoran Desert cactus — looks like test/demo data, not a real
Oregon sighting. Flagging in case it affects backfill expectations.
† A Mexican-endemic cactus logged against Arizona — genuinely zero
place-scoped observations, not an API error. Real edge case, handled below.

This is the range the log-cap needs to work over: **0 to 83,804**, spanning
four states/counties of wildly different size, with real natives, real
invasives, real ornamentals-out-of-range, and one genuine zero.

### Conservation status — confirms the majority-case assumption

**All 16 real species currently in `catches` have `conservation_status:
null`** — no assessment on iNaturalist for any of them. This directly
confirms the task's framing: conservation data being absent is the
*majority* case, not an edge case, for what this app's users are actually
catching (common ornamentals and common regional flora, mostly).

To see real conservation data, I pulled a few species known to carry a
real assessment:

| Species | Authority | Status | `iucn` (raw ordinal) |
|---|---|---|---:|
| Astrophytum asterias (sand-dollar cactus) | IUCN Red List | vulnerable | 30 |
| Sequoiadendron giganteum (giant sequoia) | IUCN Red List | endangered | 40 |
| Cycas micronesica | IUCN Red List | endangered | 40 |
| Franklinia alatamaha | IUCN Red List | extinct in the wild | 60 |
| Fritillaria gentneri (OR native, place_id=10) | Oregon Dept. of Agriculture | E | 40 |
| Astragalus applegatei (OR native, place_id=10) | U.S. Fish & Wildlife Service | E | 40 |

**Important confirmation:** `Fritillaria gentneri` and `Astragalus
applegatei` are federally-listed Oregon endemics, but `/taxa/:id` with
*no* `place_id` returns `conservation_status: null` — the top-level field
is itself place-resolved, and with no place given it can't pick one from
the taxon's several regional listings (CNPS for California, USFWS
nationally, Oregon Dept. of Agriculture for Oregon). Pass `place_id=10`
and it correctly returns the Oregon listing. **This is exactly what
`getTaxonStatus()` already does** (it always passes `placeId`) — so the
existing call is already conservation-status-correct; this was worth
confirming rather than assuming, since it's the kind of thing that's easy
to get backwards.

**The `iucn` field is the ordinal scale, already computed by iNaturalist.**
Across four completely different authorities (IUCN, CNPS, USFWS, Oregon
state agency), each with its own native vocabulary (`vu`/`en`/`ew`,
`1B.1`, `E`), iNaturalist normalizes them all onto the same 0–70 integer
scale (0=not evaluated, 10=least concern, 20=near threatened, 30=vulnerable,
40=endangered, 50=critically endangered, 60=extinct in the wild,
70=extinct). This means the task's "map status codes to an ordinal 0–1
scale" doesn't need a hand-built lookup table across every authority's
vocabulary — `iucn / 70` *is* that mapping, already done upstream, already
in the response `mapConservationStatus()` currently discards.

---

## 3. Where capture-time data is written — and where the new fetch/write belongs

`POST /catches` in `server/src/routes/api.js`, lines 691–820.

- Line 709–714: `placeId` is resolved for every request (falls back to
  Oregon/10 if nothing better).
- Line 725: `getTaxonStatus(taxonId, placeId)` is called — **this is
  already the single spot where a real, place-scoped iNaturalist lookup
  happens for every capture.** It's a cached call (10-minute TTL), so it
  costs nothing extra to also read `conservationStatus`/`iucn` off the same
  response.
- Line 792 (`if (!priorHere)`): the block that actually does `catches
  .insert(...)` — this only runs the first time a user logs a species in a
  new place. Repeats only touch `sightings`. **This is the right place to
  compute-and-store rarity once**, same as the audit already flagged for
  the "no view-time fetches" concern — it naturally happens exactly once
  per catalogue entry, not once per sighting, which matches "rarity is a
  species-in-a-place fact," not "a per-visit fact."

Plan: add one call — `getPlaceScopedObservationCount(taxonId, placeId)` (new
export in `inaturalist.js`, wrapping `/observations/species_counts`,
following the exact caching/error pattern the file already uses) —
alongside the existing `getTaxonStatus()` call, both awaited together
(`Promise.all`), and compute the score before the `insert()` at line 793.
No new route, no view-time fetch, no change to the request's cost profile
beyond one more cached iNaturalist call per *new* catalogue entry (not per
sighting).

---

## 4. Schema change

New migration, `007_add_rarity_score.sql` (and remove the dead `rarity
text` from `schema.sql` + retire migration 006 — see §0):

```sql
alter table public.catches
  add column if not exists rarity_observations_count integer,
  add column if not exists rarity_conservation_status text,
  add column if not exists rarity_conservation_iucn smallint,
  add column if not exists rarity_score numeric(4,3),
  add column if not exists rarity_band text;
```

- `rarity_observations_count` / `rarity_conservation_status` /
  `rarity_conservation_iucn` — the **raw inputs**, captured at insert time.
  Storing these (not just the final score) is what makes re-banding later
  free: if the provisional cutoffs in §5 turn out wrong, it's an `UPDATE …
  SET rarity_band = …` from stored data, never a re-fetch from iNaturalist.
- `rarity_score` — the computed 0–1 combined score, the real source of
  truth.
- `rarity_band` — denormalized text (`Common`/`Uncommon`/`Rare`/`Very
  Rare`), recomputed alongside `rarity_score` any time cutoffs change.
  Storing it (rather than computing on every read) matches how `family`
  and `type` already work in this table, and keeps `GET /catches` /
  `GET /region/:placeId/score` simple reads with no per-row computation.

No `check` constraint on `rarity_band` to start, matching how `rarity`
itself had none — same app-level-only enforcement the audit already noted
as this table's convention (`type` is the one exception, and that's
intentional there).

**After running this, verify it actually landed** the same way I just did
for this report — hit the PostgREST OpenAPI endpoint
(`GET {SUPABASE_URL}/rest/v1/` with the service-role key) and confirm the
five new columns show up in `definitions.catches.properties` — before
writing a single row through the app. That check is what would have caught
migration 006 never landing, days ago.

---

## 5. Scoring — code sketch

```js
// inaturalist.js — new export, same shape/caching pattern as the rest of the file
export async function getPlaceScopedObservationCount(taxonId, placeId) {
  return cached(`obscount:${taxonId}:${placeId}`, async () => {
    const payload = await get('/observations/species_counts', {
      place_id: placeId,
      taxon_id: taxonId,
      verifiable: 'true', // matches getNearbySpecies()'s existing convention
    })
    return payload.results?.[0]?.count ?? 0
  })
}

// mapConservationStatus() — thread `iucn` through, it's already on the response
function mapConservationStatus(taxon) {
  const status = taxon.conservation_status
  if (!status?.status) return null
  return {
    status: status.status.toUpperCase(),
    statusName: status.status_name ?? null,
    authority: status.authority ?? null,
    iucn: status.iucn ?? null, // NEW
  }
}
```

```js
// new module, e.g. services/rarity.js

// 10,000: every real "common" species in the live catches table already
// saturates this or comes close (saguaro 83.8k in AZ, Douglas-fir 11.1k in
// OR, bigleaf maple 7k, Scotch broom 5.5k), while genuine oddities
// (out-of-range ornamentals, mismatched-place catches) sit in the tens —
// see docs/rarity-scoring-plan-20260817.md §2 for the real numbers this
// was checked against.
const OBSERVATIONS_CAP = 10_000

function observationsScore(placeScopedCount) {
  const n = Math.max(0, Number(placeScopedCount) || 0)
  const raw = 1 - Math.log10(n + 1) / Math.log10(OBSERVATIONS_CAP + 1)
  return Math.min(1, Math.max(0, raw))
}

// iNaturalist's cross-authority ordinal: 0/10/20/30/40/50/60/70.
// iucn/70 is the 0–1 normalization; no other authority's status text
// needs a hand-built mapping, iNaturalist already did that part.
function conservationScore(iucn) {
  if (iucn == null) return null
  return Math.min(1, Math.max(0, iucn / 70))
}

export function computeRarity({ observationsCount, conservationIucn }) {
  const obs = observationsScore(observationsCount)
  const cons = conservationScore(conservationIucn)
  const score = cons == null ? obs : (obs + cons) / 2
  return { score: Number(score.toFixed(3)), band: bandFor(score) }
}

// PROVISIONAL — see distribution table below, not yet checked against a
// real conservation-bearing catch (none exist live today).
function bandFor(score) {
  if (score < 0.30) return 'Common'
  if (score < 0.55) return 'Uncommon'
  if (score < 0.75) return 'Rare'
  return 'Very Rare'
}
```

Wired into `POST /catches`, replacing line 808:

```js
const [status, obsCount] = await Promise.all([
  getTaxonStatus(taxonId, placeId), // already called for `type` — reused, not duplicated
  getPlaceScopedObservationCount(taxonId, placeId),
])
const rarity = computeRarity({
  observationsCount: obsCount,
  conservationIucn: status.conservationStatus?.iucn ?? null,
})
// ... .insert({ ..., rarity_observations_count: obsCount,
//               rarity_conservation_status: status.conservationStatus?.status ?? null,
//               rarity_conservation_iucn: status.conservationStatus?.iucn ?? null,
//               rarity_score: rarity.score, rarity_band: rarity.band })
```

### Real distribution the bands were checked against

Observations-only score (no live catch currently has conservation data to
blend in), all 16 real species, sorted:

| Species (place) | Place-scoped count | Score | Band |
|---|---:|---:|---|
| saguaro (AZ) | 83,804 | 0.000 | Common |
| Douglas-fir (OR) | 11,079 | 0.000 | Common |
| bigleaf maple (OR) | 7,033 | 0.038 | Common |
| Scotch broom (OR) | 5,543 | 0.064 | Common |
| Armenian blackberry (OR) | 2,866 | 0.136 | Common |
| privet (CA) | 2,498 | 0.151 | Common |
| Mexican palo verde (AZ) | 1,681 | 0.194 | Common |
| Fire Stick euphorbia (AZ) | 839 | 0.269 | Common |
| Dracaena fragrans (CA) | 665 | 0.294 | Uncommon |
| Oregon grape (Lane Co. OR) | 190 | 0.430 | Uncommon |
| Pistacia atlantica (AZ) | 27 | 0.638 | Rare |
| banana (OR) | 5 | 0.805 | Very Rare |
| teddybear cholla, Madonna lily, Tea Rose, Coryphantha (0 each) | 0 | 1.000 | Very Rare |

All four bands hit with real data, no clustering at one end — a reasonable
sign the cutoffs aren't obviously wrong, but **this is still 16 data points
from one small demo dataset with zero conservation-blended examples in it**.
Flagging as provisional exactly as asked: revisit after a real batch of
conservation-bearing catches exists, or after backfill (§6) produces a
bigger sample.

---

## 6. Backfill

**21 rows total, live, right now** (confirmed by count query) — all 21 lack
real rarity data by definition, since the column doesn't exist yet (§0).
Spans exactly the 4 place_ids in §2's table.

**A one-time script is sufficient** — 21 rows is nowhere near a scale that
needs batching. But it does need to be **per-row place-aware**, not
per-region: this data already spans 4 different places in one small table,
and scoring is inherently about "how common is this species *in the place
it was caught*" — a script that assumed one region for the whole backfill
would silently mis-score every Arizona/California/Lane-County row. Concretely:
loop the 21 rows, call `getPlaceScopedObservationCount(taxon_id, place_id)`
+ read `conservationStatus` off a `getTaxonStatus(taxon_id, place_id)` call
per row (reusing both exactly as they'll run in `POST /catches`, not a
separate implementation), compute, `update`.

Cost: worst case 2 iNaturalist calls × 21 rows = 42 calls, one-time, nowhere
near the ~60/min courtesy limit `inaturalist.js` already guards against.
Run it only after §4's migration is confirmed live via the OpenAPI check —
otherwise it repeats migration 006's exact failure mode, silently.

---

## 7. UI — two separate surfaces, both need a decision, not just a data source swap

Two different components currently read rarity-shaped data, and they don't
share a scale today:

**`client/src/views/SpeciesDetail.jsx:207-232`** (`ConservationStatus`) —
already renders the real `conservationStatus.statusName`/`authority`
correctly when present (no change needed there). Lines 225–229 are the
"NOT CALIBRATED" copy:

```jsx
<span className="badge-placeholder">Not calibrated</span> Rare / common banding needs
thresholds this app has never set. Showing a made-up scale here would read as
authoritative, so it is left out until the badge system defines one.
```

Once `rarity_score`/`rarity_band` exist on a catch row, this becomes a real
band display — but per the task's own instruction (and consistent with why
this placeholder exists at all), it should keep saying the cutoffs are
provisional rather than presenting them as settled, e.g. swap the
`badge-placeholder` span for the real `rarity_band`, and soften the
trailing sentence to something like "Provisional — based on iNaturalist
observation counts near where this was caught \[+ conservation status,
when assessed\]; thresholds may be re-tuned."

**`client/src/components/PlantCard.jsx` + `Gallery.jsx` +
`views/PlantCard_test.jsx`** — a completely separate, already-built,
already-styled 5-tier gacha rarity system (`N`/`R`/`SR`/`SSR`/`UR`, real CSS
colors in `PlantCard.css`), driven by `catches.rarity` (`Gallery.jsx:15`:
`rarity: catchRow.rarity ?? 'N'`). **This is the actual column the random
value lives in today**, and it's a different scale (5 tiers, gacha-styled)
from the 4-band Common/Uncommon/Rare/Very-Rare the task asked for. Retiring
`catches.rarity` (§0/§4) breaks this component's data source outright, so
this needs an explicit call, not a silent pick:

- **(a)** Map the new continuous `rarity_score` onto the existing 5-tier
  `N/R/SR/SSR/UR` CSS system with quintile-style cutoffs, keeping the
  gacha visual identity that's already built and styled.
- **(b)** Redefine `PlantCard` to the same 4-band scale `SpeciesDetail`
  uses, with new CSS vars — one scale everywhere, but it means touching
  `PlantCard.css`'s color system and probably its visual language too.

I'd lean (a) — it reuses real, already-designed UI rather than replacing
it, and a continuous score can back two different band counts in two
different places without contradiction — but this is a product call, not
a technical one, so flagging both rather than picking silently.

---

## 8. Summary — what changes, in order

1. Live check: confirm whether `POST /catches` is currently 500ing for new
   species (§0) — independent bug, but worth knowing before layering more
   writes onto the same insert.
2. Migration 007 (§4): add the 5 new columns; retire the dead `rarity`
   column from `schema.sql` and migration 006. Verify via the OpenAPI
   endpoint that it actually landed, before touching app code.
3. `inaturalist.js` (§5): add `getPlaceScopedObservationCount()`; thread
   `iucn` through `mapConservationStatus()`.
4. New `services/rarity.js` (§5): `computeRarity()` + the provisional
   band cutoffs, clearly commented as provisional with the real numbers
   behind the cap.
5. `POST /catches` (§3): call the new observation-count function alongside
   the existing `getTaxonStatus()` call, write the 5 new columns instead
   of the random `rarity` pick.
6. One-time backfill script (§6): 21 rows, per-row place-scoped, reusing
   the same functions as step 5.
7. UI (§7): real band copy in `SpeciesDetail`; a decision + implementation
   for `PlantCard`'s gacha scale.

Not yet implemented, per the brief. Ready to build in this order once you
confirm the open calls in §0 and §7.
