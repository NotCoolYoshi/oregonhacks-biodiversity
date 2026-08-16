// Recompute place_id, place_name and type for catches logged before the
// verdict became location-aware.
//
//   npm --prefix server run backfill:places            # dry run, writes nothing
//   npm --prefix server run backfill:places -- --apply # actually writes
//
// Dry run is the default and --apply is the only way to write, because this
// script can change a row's `type`, and `type` is what POINTS are awarded from.
// A wrong bulk write here silently rewrites history.
//
// Why this is needed: until the location fix, every catch was classified
// against a fixed place id (Oregon) no matter where the photo was taken. Those
// rows carry a place_id, place_name and — because the classification read the
// same broken place — possibly a `type` that describes the wrong region.
//
// The recomputation uses exactly the same functions the live routes use, so
// this cannot drift from what a fresh catch would record today.

import 'dotenv/config'
import { pathToFileURL } from 'node:url'

import { getSupabase, isConfigured } from '../src/db/supabaseClient.js'
import { resolvePlaceFromCoords, getTaxonStatus } from '../src/services/inaturalist.js'

const APPLY = process.argv.includes('--apply')

// Running as a script vs. imported by the test below. Everything above this
// line is pure; everything under `if (isMain)` talks to the database.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

// iNaturalist asks for courteous use and caps at ~60 requests/minute. Each row
// costs up to two calls (place + taxon status), both memoised, so this is
// politeness rather than necessity at current scale.
const PAUSE_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The unique index from migration 002, as a string key. */
const uniqueKey = (row) => `${row.user_id}|${row.taxon_id}|${row.place_id}`

/**
 * Number(), but null is not zero.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain
 * Number.isFinite(row.lat) check treats a row with no coordinates as a row at
 * 0°N 0°E — a spot in the Atlantic. That resolves to no place, so such rows
 * were still skipped rather than corrupted, but they were skipped for the
 * wrong stated reason and cost a pointless lookup each.
 */
const coord = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))

const hasCoords = (row) => Number.isFinite(coord(row.lat)) && Number.isFinite(coord(row.lng))

const fmt = (v) => (v === null || v === undefined ? '∅' : String(v))

/**
 * Flag any plan whose result would violate the unique index, against the
 * PROJECTED final state rather than the current table.
 *
 * Moving a row to a new place_id can collide two ways: with a row that is
 * staying put, and with another row being moved to the same place in this same
 * run. Only projecting catches the second — checking each proposed change
 * against the table as it stands today would wave through two rows converging
 * on one key, and the second UPDATE would fail with 23505 halfway through the
 * batch, leaving the table half-written.
 *
 * Mutates the plans in place and returns them. Pure otherwise, and exported so
 * the case this database does not currently contain can still be tested.
 */
export function markCollisions(plans) {
  const projected = new Map()

  for (const plan of plans) {
    // A skipped or errored row still occupies its existing key — it is still
    // in the table, and something else moving onto that key is still a clash.
    const finalRow = plan.action === 'update' ? { ...plan.row, ...plan.changes } : plan.row
    const key = uniqueKey(finalRow)
    if (!projected.has(key)) projected.set(key, [])
    projected.get(key).push(plan)
  }

  for (const [key, group] of projected) {
    if (group.length < 2) continue
    for (const plan of group) {
      plan.collision = {
        key,
        with: group.filter((other) => other !== plan).map((other) => other.row.id),
      }
      // Never resolved automatically: the options are to drop a row or to merge
      // two real observations, and both are the operator's call.
      if (plan.action === 'update') plan.action = 'collision'
    }
  }

  return plans
}

/** Everything that touches the database. Runs only when this is the entry point. */
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
  .select('id, user_id, taxon_id, scientific_name, common_name, type, place_id, place_name, lat, lng, created_at')
  .order('created_at', { ascending: true })

if (error) {
  console.error(`Could not read catches: ${error.message}`)
  process.exit(1)
}

console.log(`\n${APPLY ? '⚠️  APPLY MODE — this will write' : 'DRY RUN — nothing will be written'}`)
console.log(`Read ${rows.length} catch rows.\n`)

// ---------------------------------------------------------------------------
// Pass 1 — work out what each row should say, without writing anything
// ---------------------------------------------------------------------------

const plans = []

for (const row of rows) {
  if (!hasCoords(row)) {
    // Nothing to recompute from. A row with no coordinates was never
    // location-aware and cannot be made so retroactively — leaving it alone is
    // the only honest option.
    plans.push({ row, action: 'skip', reason: 'no coordinates' })
    continue
  }

  let place
  try {
    place = await resolvePlaceFromCoords(row.lat, row.lng)
  } catch (err) {
    plans.push({ row, action: 'error', reason: `place lookup failed: ${err.message}` })
    continue
  }

  if (!place) {
    plans.push({ row, action: 'skip', reason: 'coordinates are in no iNaturalist place' })
    continue
  }

  let status
  try {
    status = await getTaxonStatus(row.taxon_id, place.placeId)
  } catch (err) {
    plans.push({ row, action: 'error', reason: `taxon status failed: ${err.message}` })
    continue
  }

  const next = {
    place_id: place.placeId,
    place_name: place.placeName,
    type: status.classification,
  }

  const changes = {}
  if (Number(row.place_id) !== Number(next.place_id)) changes.place_id = next.place_id
  if (row.place_name !== next.place_name) changes.place_name = next.place_name
  if (row.type !== next.type) changes.type = next.type

  plans.push({
    row,
    action: Object.keys(changes).length === 0 ? 'unchanged' : 'update',
    next,
    changes,
    establishmentMeans: status.establishmentMeans,
  })

  await sleep(PAUSE_MS)
}

markCollisions(plans)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const byAction = (action) => plans.filter((plan) => plan.action === action)

const line = (label, value) => `    ${label.padEnd(14)} ${value}`

console.log('─'.repeat(78))
for (const plan of plans) {
  const { row } = plan
  const name = row.common_name ?? row.scientific_name
  const coords = hasCoords(row) ? `${row.lat}, ${row.lng}` : 'none recorded'

  console.log(`\n${row.id.slice(0, 8)}  ${name}  (taxon ${row.taxon_id})`)
  console.log(line('user', row.user_id))
  console.log(line('coords', coords))
  console.log(line('logged', row.created_at))

  if (plan.action === 'skip' || plan.action === 'error') {
    console.log(line('→', `${plan.action.toUpperCase()}: ${plan.reason}`))
    console.log(line('stored', `place ${fmt(row.place_id)} "${fmt(row.place_name)}" type=${row.type}`))
    continue
  }

  console.log(line('stored', `place ${fmt(row.place_id)} "${fmt(row.place_name)}" type=${row.type}`))
  console.log(
    line('today', `place ${plan.next.place_id} "${plan.next.place_name}" type=${plan.next.type}` +
      `  (means: ${plan.establishmentMeans})`),
  )

  if (plan.action === 'unchanged') {
    console.log(line('→', 'UNCHANGED'))
    continue
  }

  if (plan.action === 'collision') {
    console.log(line('→', `⛔ COLLISION on (user_id, taxon_id, place_id) = ${plan.collision.key}`))
    console.log(line('', `clashes with row(s): ${plan.collision.with.map((id) => id.slice(0, 8)).join(', ')}`))
    console.log(line('', 'NOT written — resolve by hand.'))
    continue
  }

  const parts = Object.entries(plan.changes).map(
    ([field, value]) => `${field}: ${fmt(row[field])} → ${fmt(value)}`,
  )
  console.log(line('→', `UPDATE  ${parts.join('  |  ')}`))

  if (plan.changes.type) {
    console.log(
      line('', `🚩 TYPE CHANGE — this moves points ${row.type === 'threat_report' ? '25 → 10' : '10 → 25'}`),
    )
  }
}

console.log(`\n${'─'.repeat(78)}`)

const typeChanges = byAction('update').filter((plan) => plan.changes.type)

console.log('\nSummary')
console.log(`  unchanged        ${byAction('unchanged').length}`)
console.log(`  to update        ${byAction('update').length}`)
console.log(`  of those, type   ${typeChanges.length}  ${typeChanges.length ? '🚩 review these by eye' : ''}`)
console.log(`  collisions       ${byAction('collision').length}`)
console.log(`  skipped          ${byAction('skip').length}`)
console.log(`  errors           ${byAction('error').length}`)

if (typeChanges.length > 0) {
  console.log('\n🚩 Rows whose `type` would change (this rewrites historical point totals):')
  for (const plan of typeChanges) {
    console.log(
      `   ${plan.row.id.slice(0, 8)}  ${plan.row.common_name ?? plan.row.scientific_name}  ` +
        `${plan.row.type} → ${plan.changes.type}  (${plan.establishmentMeans} in ${plan.next.place_name})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

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
  const { error: updateError } = await sb
    .from('catches')
    .update(plan.changes)
    .eq('id', plan.row.id)

  if (updateError) {
    // 23505 here means the projected-state check missed something; stop rather
    // than continue writing on a wrong model of the table.
    console.error(`  ✗ ${plan.row.id.slice(0, 8)}: ${updateError.message}`)
    console.error('    Stopping. No further rows will be written.')
    process.exit(1)
  }

  written += 1
  console.log(`  ✓ ${plan.row.id.slice(0, 8)}  ${Object.keys(plan.changes).join(', ')}`)
}

console.log(`\nDone — ${written} row(s) updated. Re-run without --apply to confirm idempotency.\n`)
}

if (isMain) await main()
