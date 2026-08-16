// The backfill's collision guard.
//
// This is the one part of scripts/backfill-places.mjs that must be right
// before it is ever run with --apply: it is what stands between a bulk update
// and a half-written table. The production database happens to contain no
// collision today, so without a test this guard would go to production
// unexercised — and it is precisely the case that only shows up once.
//
// Same shape as the other suites here: no framework, exit non-zero on failure.

import { markCollisions } from '../scripts/backfill-places.mjs'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

const row = (id, user_id, taxon_id, place_id) => ({ id, user_id, taxon_id, place_id })

const update = (r, changes) => ({ row: r, action: 'update', changes })
const skip = (r) => ({ row: r, action: 'skip', reason: 'no coordinates' })
const unchanged = (r) => ({ row: r, action: 'unchanged' })

console.log('\n-- a move onto a row that is staying put --')
{
  // The near-miss this database really contains: usr_demo_alice has Oregon
  // grape logged twice, once at place 10 and once at place 962. The 962 row
  // has no coordinates so it is skipped today — but if it had them, it would
  // resolve to Oregon and land on the other row's key.
  const staying = row('keep', 'alice', 126887, 10)
  const moving = row('move', 'alice', 126887, 962)

  const plans = markCollisions([unchanged(staying), update(moving, { place_id: 10 })])

  check('the moving row is flagged, not written',
    plans[1].action === 'collision', plans[1].action)
  check('...naming the row it clashes with',
    plans[1].collision.with.includes('keep'), JSON.stringify(plans[1].collision))
  check('...and the key that clashes',
    plans[1].collision.key === 'alice|126887|10', plans[1].collision.key)
  check('the row that was already there is not turned into an update',
    plans[0].action === 'unchanged', plans[0].action)
}

console.log('\n-- two rows converging on the same key in one run --')
{
  // Neither collides with the table as it stands; they collide with each
  // other. Checking each change against the current table would wave both
  // through and the second UPDATE would 23505 mid-batch.
  const a = row('a', 'bob', 61317, 10)
  const b = row('b', 'bob', 61317, 962)

  const plans = markCollisions([update(a, { place_id: 40 }), update(b, { place_id: 40 })])

  check('both sides of the convergence are flagged',
    plans.every((p) => p.action === 'collision'), JSON.stringify(plans.map((p) => p.action)))
  check('each names the other',
    plans[0].collision.with[0] === 'b' && plans[1].collision.with[0] === 'a',
    JSON.stringify(plans.map((p) => p.collision.with)))
}

console.log('\n-- a skipped row still occupies its key --')
{
  // A row that cannot be recomputed is still in the table. Something else
  // moving onto its key is still a clash.
  const parked = skip(row('parked', 'carol', 48227, 10))
  const moving = row('mover', 'carol', 48227, 962)

  const plans = markCollisions([parked, update(moving, { place_id: 10 })])

  check('the mover is flagged against the skipped row',
    plans[1].action === 'collision', plans[1].action)
  check('the skipped row stays skipped rather than becoming a collision',
    plans[0].action === 'skip', plans[0].action)
}

console.log('\n-- things that are not collisions --')
{
  const plans = markCollisions([
    // Same species and place, different users — the index is per user.
    update(row('u1', 'alice', 126887, 962), { place_id: 10 }),
    unchanged(row('u2', 'bob', 126887, 10)),
    // Same user and place, different species.
    update(row('t1', 'alice', 61317, 962), { place_id: 10 }),
  ])

  check('different users on one place do not collide',
    plans[0].action === 'update', plans[0].action)
  check('different taxa on one place do not collide',
    plans[2].action === 'update', plans[2].action)
  check('no collision metadata is attached',
    plans.every((p) => !p.collision), JSON.stringify(plans.map((p) => p.collision)))
}

console.log('\n-- a rename that does not move place_id is never a collision --')
{
  // The common case in this backfill: "Oregon" -> "Oregon, US" at the same
  // place id. The row keeps its own key, so it can only clash with itself.
  const r = row('rename', 'alice', 126887, 10)
  const plans = markCollisions([update(r, { place_name: 'Oregon, US' })])

  check('a pure rename stays an update', plans[0].action === 'update', plans[0].action)
  check('...with no collision', !plans[0].collision)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
