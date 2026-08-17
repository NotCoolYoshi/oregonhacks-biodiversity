// Compute rarity_score/rarity_band (+ raw inputs) for catches rows written
// before migration 007 existed — every row today, since the column didn't
// exist until now.
//
//   npm --prefix server run backfill:rarity            # dry run, writes nothing
//   npm --prefix server run backfill:rarity -- --apply # actually writes
//
// Dry run is the default and --apply is the only way to write, same pattern
// as backfill-places.mjs.
//
// Per-row, not per-region: run this against the live table today and it
// touches four different place_ids (Oregon, Arizona, California, Lane
// County OR — see docs/rarity-scoring-plan-20260817.md §2/§6). A single
// fixed place for the whole backfill would silently mis-score every row
// outside it. Each row is scored against its OWN place_id, using exactly
// the functions POST /catches uses for a live capture — see that route's
// (!priorHere) block — so this cannot drift from what a fresh catch records.
//
// Only rows with rarity_score currently null are touched; already-scored
// rows are left alone and reported as skipped, so a partial run (or a
// second pass after new rows land) doesn't re-spend iNaturalist calls or
// silently overwrite a score computed at a different observation count.

import 'dotenv/config'
import { pathToFileURL } from 'node:url'

import { getSupabase, isConfigured } from '../src/db/supabaseClient.js'
import { getTaxonStatus, getPlaceScopedObservationCount } from '../src/services/inaturalist.js'
import { computeRarity } from '../src/services/rarity.js'

const APPLY = process.argv.includes('--apply')

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

// iNaturalist asks for courteous use, ~60 requests/minute. Each row costs up
// to two calls (taxon status + place-scoped observation count), both
// memoised — politeness, not necessity, at the current 21-row scale.
const PAUSE_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fmt = (v) => (v === null || v === undefined ? '∅' : String(v))

async function main() {
  if (!isConfigured()) {
    console.error(
      'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env.',
    )
    process.exit(1)
  }

  const sb = getSupabase()

  const { data: rows, error } = await sb
    .from('catches')
    .select('id, taxon_id, scientific_name, common_name, place_id, place_name, rarity_score, created_at')
    .order('created_at', { ascending: true })

  if (error) {
    console.error(`Could not read catches: ${error.message}`)
    console.error(
      'If this says `column catches.rarity_score does not exist`, migration 007 has not ' +
        'landed on this project yet — run it first (server/src/db/migrations/007_add_rarity_score.sql) ' +
        'and verify it landed before re-running this script. See that migration\'s header comment.',
    )
    process.exit(1)
  }

  console.log(`\n${APPLY ? '⚠️  APPLY MODE — this will write' : 'DRY RUN — nothing will be written'}`)
  console.log(`Read ${rows.length} catch row(s).\n`)

  const plans = []

  for (const row of rows) {
    if (row.rarity_score != null) {
      plans.push({ row, action: 'skip', reason: 'already scored' })
      continue
    }

    if (!row.place_id) {
      // Same honesty rule as backfill-places.mjs's coordinate check: a row
      // with no place to score against cannot be made place-scoped
      // retroactively by guessing one.
      plans.push({ row, action: 'skip', reason: 'no place_id on this row' })
      continue
    }

    let status
    try {
      status = await getTaxonStatus(row.taxon_id, row.place_id)
    } catch (err) {
      plans.push({ row, action: 'error', reason: `taxon status failed: ${err.message}` })
      continue
    }

    let observationsCount
    try {
      observationsCount = await getPlaceScopedObservationCount(row.taxon_id, row.place_id)
    } catch (err) {
      plans.push({ row, action: 'error', reason: `observation count failed: ${err.message}` })
      continue
    }

    const conservationIucn = status.conservationStatus?.iucn ?? null
    const rarity = computeRarity({ observationsCount, conservationIucn })

    plans.push({
      row,
      action: 'update',
      changes: {
        rarity_observations_count: observationsCount,
        rarity_conservation_status: status.conservationStatus?.status ?? null,
        rarity_conservation_iucn: conservationIucn,
        rarity_score: rarity.score,
        rarity_band: rarity.band,
      },
    })

    await sleep(PAUSE_MS)
  }

  console.log('─'.repeat(78))
  for (const plan of plans) {
    const { row } = plan
    const name = row.common_name ?? row.scientific_name

    console.log(`\n${row.id.slice(0, 8)}  ${name}  (taxon ${row.taxon_id}, place ${fmt(row.place_id)} "${fmt(row.place_name)}")`)

    if (plan.action === 'skip' || plan.action === 'error') {
      console.log(`    → ${plan.action.toUpperCase()}: ${plan.reason}`)
      continue
    }

    const c = plan.changes
    console.log(
      `    → obs=${c.rarity_observations_count}  ` +
        `conservation=${fmt(c.rarity_conservation_status)}${c.rarity_conservation_iucn != null ? ` (iucn ${c.rarity_conservation_iucn})` : ''}  ` +
        `score=${c.rarity_score}  band=${c.rarity_band}`,
    )
  }

  console.log(`\n${'─'.repeat(78)}`)

  const byAction = (action) => plans.filter((plan) => plan.action === action)
  console.log('\nSummary')
  console.log(`  to update   ${byAction('update').length}`)
  console.log(`  skipped     ${byAction('skip').length}`)
  console.log(`  errors      ${byAction('error').length}`)

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to write these changes.\n')
    process.exit(0)
  }

  const updates = byAction('update')
  if (updates.length === 0) {
    console.log('\nNothing to write.\n')
    process.exit(0)
  }

  console.log(`\nWriting ${updates.length} row(s)…`)

  let written = 0
  for (const plan of updates) {
    const { error: updateError } = await sb.from('catches').update(plan.changes).eq('id', plan.row.id)

    if (updateError) {
      console.error(`  ✗ ${plan.row.id.slice(0, 8)}: ${updateError.message}`)
      console.error('    Stopping. No further rows will be written.')
      process.exit(1)
    }

    written += 1
    console.log(`  ✓ ${plan.row.id.slice(0, 8)}  score=${plan.changes.rarity_score} band=${plan.changes.rarity_band}`)
  }

  console.log(`\nDone — ${written} row(s) updated. Re-run without --apply to confirm idempotency (everything should now show "already scored").\n`)
}

if (isMain) await main()
