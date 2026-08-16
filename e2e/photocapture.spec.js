// End-to-end coverage of the PhotoCapture flow against the real stack.
//
// Nothing is mocked: a real photo goes to real Pl@ntNet, the species is
// classified by real iNaturalist, and the catch is written to the real
// Supabase project. The mocked paths are already covered by server/test and
// client/test — this suite exists to find out what actually happens when the
// three integrations meet, including the two behaviours nobody has pinned down
// yet (geolocation denial, and whether the organ tag does anything).
//
// Every row this suite writes is deleted in afterAll. Rows are identified by a
// per-run user id prefix, so cleanup can never touch the pre-existing demo
// data — see the teardown at the bottom.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { test, expect } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const PHOTO = resolve(HERE, 'fixtures/scotch-broom.jpg')

// The fixture is a real research-grade Cytisus scoparius (Scotch broom) photo
// from iNaturalist. It identifies at ~0.24, comfortably over the server's 0.1
// MIN_CONFIDENCE floor, and Scotch broom is introduced in Oregon — so the flow
// exercises the threat_report branch as well as the catch branch.
//
// That 0.24 also sits well under the client's 0.75 auto-proceed bar, so every
// run here walks the whole retry ladder rather than committing on the first
// photo: four "try another photo" screens, then attempt 5 settles for the best
// result seen. Deliberately not swapped for a >=0.75 fixture — this is the path
// a real user with a real plant actually takes, and it is worth covering.
// The cost is five Pl@ntNet calls per identify, against a 500/day free tier;
// see MAX_ATTEMPTS below if that ever becomes the binding constraint.
const EXPECTED_SPECIES = 'Cytisus scoparius'
const EXPECTED_TYPE = 'threat_report'
const EXPECTED_POINTS = 25
const PLACE_ID = 10

// MAX_ATTEMPTS in client/src/views/PhotoCapture.jsx. The ladder stops here and
// proceeds with whatever scored highest.
const MAX_ATTEMPTS = 5

// Eugene, Oregon.
const OREGON = { latitude: 44.0521, longitude: -123.0868 }

// localStorage key from client/src/session.js.
const USER_ID_KEY = 'oregonhacks.userId'

const RUN = `e2e${Date.now().toString(36)}`
const userIdFor = (label) => `usr_${RUN}_${label}`

// Every user id this run has handed to a browser. Cleanup is scoped to these.
const runUserIds = new Set()

// ---------------------------------------------------------------------------
// Supabase, configured exactly as the server does
// ---------------------------------------------------------------------------

// server/.env is not loaded for us — the Playwright process is not the server.
// Parse it directly rather than adding a dotenv dependency at the repo root.
for (const line of readFileSync(resolve(HERE, '../server/.env'), 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const index = trimmed.indexOf('=')
  if (index === -1) continue
  const key = trimmed.slice(0, index)
  if (!process.env[key]) process.env[key] = trimmed.slice(index + 1)
}

// Loaded from the server's own module so the test talks to the database
// through the exact client the server uses, service role key and all. Bare
// specifiers inside it resolve against server/node_modules.
//
// Imported lazily rather than at the top level: Playwright loads spec files
// through a CommonJS transform, and a top-level await would make the file
// unloadable ("require() cannot be used on an ESM graph with top-level await").
let supabasePromise
function supabaseClient() {
  supabasePromise ??= import('../server/src/db/supabaseClient.js').then((module) =>
    module.getSupabase(),
  )
  return supabasePromise
}

// ---------------------------------------------------------------------------
// Diagnostics (check 1)
// ---------------------------------------------------------------------------

/**
 * Console errors that are really just a non-2xx response being reported by the
 * browser. Those are covered by the network log, and some are expected — the
 * duplicate-catch test deliberately provokes a 409.
 */
const NETWORK_NOISE = /Failed to load resource|net::ERR_/i

function watch(page, diagnostics) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    ;(NETWORK_NOISE.test(text) ? diagnostics.networkConsole : diagnostics.consoleErrors).push(text)
  })

  // An uncaught exception in the app is never acceptable.
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)))

  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return
    diagnostics.requests.push({
      method: request.method(),
      url: request.url(),
      // Cheap to hold for the small bodies; identify's is read on demand.
      postData: request.url().includes('/api/identify') ? null : request.postData(),
      request,
    })
  })

  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return
    if (response.status() >= 200 && response.status() < 300) return
    diagnostics.nonOk.push({ status: response.status(), url: response.url() })
  })
}

function newDiagnostics() {
  return { consoleErrors: [], networkConsole: [], pageErrors: [], requests: [], nonOk: [] }
}

/** Reports non-2xx responses without failing; fails on genuine JS errors. */
function assertClean(diagnostics, label) {
  if (diagnostics.nonOk.length > 0) {
    console.log(`  [${label}] non-2xx responses (reported, not failed):`)
    for (const entry of diagnostics.nonOk) {
      console.log(`    ${entry.status} ${entry.url.replace('http://localhost:5001', '')}`)
    }
  }
  expect(diagnostics.pageErrors, `uncaught page errors in ${label}`).toEqual([])
  expect(diagnostics.consoleErrors, `unexpected console errors in ${label}`).toEqual([])
}

const apiCalls = (diagnostics) =>
  diagnostics.requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

/**
 * A context with a known user id and a record of every capture state the UI
 * passes through.
 *
 * The state recorder matters: several states (Identifying…, Saving…) are
 * transient, and polling for them races the app. A MutationObserver installed
 * before any script runs catches every heading the flow renders, so the
 * sequence can be asserted after the fact instead of mid-flight.
 */
async function openApp(browser, { userId, geolocation }) {
  runUserIds.add(userId)

  const context = await browser.newContext(
    geolocation ? { geolocation, permissions: ['geolocation'] } : {},
  )

  await context.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value)

      window.__states = []
      const record = () => {
        const heading = document.querySelector('.capture h2')
        const text = heading && heading.textContent.trim()
        if (text && window.__states[window.__states.length - 1] !== text) {
          window.__states.push(text)
        }
      }
      // Observe `document` itself, not documentElement: this script runs at
      // document_start, where documentElement is still null and observe()
      // would throw.
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      })
      document.addEventListener('DOMContentLoaded', record)
    },
    { key: USER_ID_KEY, value: userId },
  )

  const diagnostics = newDiagnostics()
  const page = await context.newPage()
  watch(page, diagnostics)

  return { context, page, diagnostics }
}

const statesSeen = (page) => page.evaluate(() => window.__states ?? [])

// ---------------------------------------------------------------------------
// Flow steps
// ---------------------------------------------------------------------------

// '/' is the home dashboard; capture lives on its own route.
async function chooseOrganAndPhoto(page, organ) {
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Photo Capture' })).toBeVisible()

  await page.locator(`input[name="organ"][value="${organ}"]`).check()
  await page.locator('input[type="file"]').setInputFiles(PHOTO)
}

const retryHeading = (page) => page.getByRole('heading', { name: /Not confident enough/ })

// The status-preview screen titles itself with the species it settled on.
const speciesHeading = (page) => page.getByRole('heading', { name: EXPECTED_SPECIES })

/**
 * Drive identification until the app commits to a species, feeding it the same
 * photo each time it asks for a better one.
 *
 * There is no candidate list to click any more: the app either clears 0.75 and
 * proceeds by itself, or spends the ladder and proceeds with its best result.
 * Both outcomes land on status-preview, so this returns the attempt it took to
 * get there — 1 for a confident photo, MAX_ATTEMPTS for the fixture.
 */
async function identify(page) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await page.getByRole('button', { name: 'Identify this plant' }).click()

    // Either screen is a valid landing; racing them avoids assuming which.
    await expect(retryHeading(page).or(speciesHeading(page))).toBeVisible({ timeout: 90_000 })
    if (await speciesHeading(page).isVisible()) return attempt

    await page.getByRole('button', { name: 'Take another photo' }).click()
    await expect(page.getByRole('heading', { name: 'Photo Capture' })).toBeVisible()
    await page.locator('input[type="file"]').setInputFiles(PHOTO)
  }

  throw new Error(`never reached a species after ${MAX_ATTEMPTS} attempts`)
}

/** Waits out the status lookup, then submits. Returns the button's label. */
async function confirmCatch(page) {
  const submit = page.locator('.capture-actions button').first()
  await expect(submit).toBeEnabled({ timeout: 60_000 })
  const label = (await submit.textContent()).trim()
  await submit.click()
  return label
}

/** The POST /api/catches body the browser actually sent, parsed. */
function catchRequestBody(diagnostics) {
  const entry = diagnostics.requests.find(
    (item) => item.method === 'POST' && item.url.endsWith('/api/catches'),
  )
  return entry?.postData ? JSON.parse(entry.postData) : null
}

// ---------------------------------------------------------------------------

// Serial: check 7 asserts on the row that check 5 creates, and the whole file
// shares one live database and one Pl@ntNet quota.
test.describe.serial('PhotoCapture against the real stack', () => {
  // Shared between checks 5 and 7 so the duplicate is a genuine repeat of the
  // same user + species + place.
  const walkthroughUser = userIdFor('walk')

  test('2. geolocation allowed — coordinates reach POST /api/catches', async ({ browser }) => {
    const { context, page, diagnostics } = await openApp(browser, {
      userId: userIdFor('geo-on'),
      geolocation: OREGON,
    })

    await chooseOrganAndPhoto(page, 'flower')
    await expect(page.getByText(/Location ready/)).toBeVisible({ timeout: 30_000 })

    await identify(page)
    await confirmCatch(page)
    await expect(page.locator('.capture h2')).toContainText(/New species|Threat reported|Caught/, {
      timeout: 90_000,
    })

    const body = catchRequestBody(diagnostics)
    expect(body, 'POST /api/catches was sent').not.toBeNull()
    expect(body.location, 'location present in request body').toBeTruthy()
    expect(body.location.lat).toBeCloseTo(OREGON.latitude, 4)
    expect(body.location.lng).toBeCloseTo(OREGON.longitude, 4)

    console.log(`  [geo allowed] sent location ${body.location.lat}, ${body.location.lng}`)
    assertClean(diagnostics, 'geo allowed')
    await context.close()
  })

  test('3. geolocation denied — record what actually happens', async ({ browser }) => {
    // No permissions granted: getCurrentPosition invokes its error callback.
    const { context, page, diagnostics } = await openApp(browser, {
      userId: userIdFor('geo-off'),
    })
    await context.clearPermissions()

    await chooseOrganAndPhoto(page, 'flower')

    const noLocationNotice = page.getByText(/No location/)
    const noticeShown = await noLocationNotice.isVisible().catch(() => false)

    await identify(page)
    await confirmCatch(page)

    // waitFor, not isVisible: isVisible is an immediate check and would report
    // false before the result screen had a chance to render.
    const reachedResult = await page
      .locator('.capture h2')
      .filter({ hasText: /New species|Threat reported|Caught/ })
      .waitFor({ state: 'visible', timeout: 90_000 })
      .then(() => true, () => false)

    const body = catchRequestBody(diagnostics)

    // Findings, not assertions — this behaviour had no agreed answer.
    console.log('  [geo denied] FINDINGS')
    console.log(`    idle screen warned the user: ${noticeShown}`)
    console.log(`    submission was blocked:      ${!body}`)
    console.log(`    request omitted location:    ${body ? !('location' in body) : 'n/a'}`)
    console.log(`    location value sent:         ${JSON.stringify(body?.location ?? null)}`)
    console.log(`    reached the result screen:   ${reachedResult}`)

    // The one thing that would be a bug either way: silently failing.
    expect(reachedResult, 'denial must not dead-end the flow').toBe(true)
    assertClean(diagnostics, 'geo denied')
    await context.close()
  })

  test('4. real photo upload reaches /api/identify as image data', async ({ browser }) => {
    const { context, page, diagnostics } = await openApp(browser, {
      userId: userIdFor('upload'),
      geolocation: OREGON,
    })

    await chooseOrganAndPhoto(page, 'flower')

    const preview = page.locator('img.capture-preview')
    await expect(preview, 'preview renders after FileReader').toBeVisible()
    const previewSrc = await preview.getAttribute('src')
    expect(previewSrc.startsWith('data:image/jpeg;base64,'), 'preview is a real data URL').toBe(true)

    await identify(page)

    const entry = diagnostics.requests.find((item) => item.url.endsWith('/api/identify'))
    const sent = JSON.parse(entry.request.postData())

    // The fixture is ~356KB, so base64 lands near 475KB. A placeholder or an
    // empty read would be orders of magnitude smaller.
    expect(sent.imageBase64.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(sent.imageBase64.length).toBeGreaterThan(100_000)
    expect(sent.organs).toEqual(['flower'])

    console.log(
      `  [upload] identify carried ${Math.round(sent.imageBase64.length / 1024)}KB of base64`,
    )
    assertClean(diagnostics, 'upload')
    await context.close()
  })

  test('5. full six-state walkthrough on real backends', async ({ browser }) => {
    const { context, page, diagnostics } = await openApp(browser, {
      userId: walkthroughUser,
      geolocation: OREGON,
    })

    await chooseOrganAndPhoto(page, 'flower')
    const attemptsTaken = await identify(page)

    // The fixture cannot clear 0.75, so the ladder must have run to the end and
    // settled rather than committing early.
    expect(attemptsTaken, 'a sub-threshold photo spends the whole ladder').toBe(MAX_ATTEMPTS)

    // status-preview
    const verdict = page.locator('.capture-verdict').first()
    await expect(verdict).toBeVisible({ timeout: 60_000 })
    await expect(verdict).toContainText(/Invasive — report this threat|Native — ready to catch/)

    const submitLabel = await confirmCatch(page)

    // result
    const heading = page.locator('.capture h2')
    await expect(heading).toContainText(/New species|Threat reported|Caught/, { timeout: 90_000 })
    await expect(page.locator('.capture-verdict')).toContainText(`+${EXPECTED_POINTS} points`)
    await expect(heading, 'fresh species+place+user celebrates a first catch').toContainText(
      'New species',
    )

    // Every state rendered something distinguishable, in order.
    const states = await statesSeen(page)
    console.log(`  [walkthrough] states: ${states.join(' -> ')}`)
    expect(states).toContain('Photo Capture')
    expect(states, 'identifying state rendered').toContain('Identifying…')
    expect(states, 'submitting state rendered').toContain('Saving…')
    expect(
      states.some((state) => state.startsWith('Not confident enough')),
      'the retry screen stood in for the old candidate list',
    ).toBe(true)
    expect(
      states.some((state) => state === 'Is it one of these?'),
      'manual candidate selection is gone',
    ).toBe(false)
    expect(states.some((state) => state.includes('New species'))).toBe(true)
    // status-preview renders the scientific name as its heading.
    expect(states.some((state) => state.includes(EXPECTED_SPECIES))).toBe(true)

    // Call order.
    const calls = apiCalls(diagnostics)
    console.log(`  [walkthrough] api: ${calls.join(' | ')}`)
    const identifyAt = calls.findIndex((call) => call === 'POST /api/identify')
    const statusAt = calls.findIndex((call) => call.includes('/status'))
    const catchAt = calls.findIndex((call) => call === 'POST /api/catches')

    expect(identifyAt, 'identify fired').toBeGreaterThanOrEqual(0)
    expect(statusAt, 'status fired after identify').toBeGreaterThan(identifyAt)
    expect(catchAt, 'catch fired after status').toBeGreaterThan(statusAt)

    console.log(`  [walkthrough] submit button read "${submitLabel}"`)
    assertClean(diagnostics, 'walkthrough')
    await context.close()
  })

  test('6. does the organ tag change anything end to end?', async ({ browser }) => {
    const { context, page, diagnostics } = await openApp(browser, {
      userId: userIdFor('organ'),
      geolocation: OREGON,
    })

    /** Identify the same photo with one organ; return what went out and came back. */
    const runWith = async (organ) => {
      await chooseOrganAndPhoto(page, organ)
      const responsePromise = page.waitForResponse(
        (response) => response.url().endsWith('/api/identify') && response.status() === 200,
        { timeout: 90_000 },
      )
      await page.getByRole('button', { name: 'Identify this plant' }).click()
      const response = await responsePromise
      // One call only — this check is about the request and the payload, so it
      // does not need the ladder run to completion. The fixture scores under
      // 0.75, so the first attempt always lands on the retry screen.
      await expect(retryHeading(page)).toBeVisible({ timeout: 90_000 })

      const request = response.request()
      const payload = await response.json()

      return {
        sentOrgans: JSON.parse(request.postData()).organs,
        echoedOrgans: payload.query?.organs ?? null,
        results: payload.results.map((result) => ({
          name: result.scientificName,
          score: result.score,
        })),
      }
    }

    const flower = await runWith('flower')

    // Back to idle without submitting — no database write needed for this one.
    // "Start over" rather than "Take another photo": the second organ must run
    // against a fresh attempt counter, not attempt 2 of the first ladder.
    await page.getByRole('button', { name: 'Start over' }).click()
    await expect(page.getByRole('heading', { name: 'Photo Capture' })).toBeVisible()

    const leaf = await runWith('leaf')

    const sameRanking =
      JSON.stringify(flower.results.map((r) => r.name)) ===
      JSON.stringify(leaf.results.map((r) => r.name))
    const sameScores =
      JSON.stringify(flower.results.map((r) => r.score)) ===
      JSON.stringify(leaf.results.map((r) => r.score))

    console.log('  [organ] FINDINGS')
    console.log(`    request organs  flower=${JSON.stringify(flower.sentOrgans)} leaf=${JSON.stringify(leaf.sentOrgans)}`)
    console.log(`    echoed by server flower=${JSON.stringify(flower.echoedOrgans)} leaf=${JSON.stringify(leaf.echoedOrgans)}`)
    console.log(`    identical ranking: ${sameRanking}`)
    console.log(`    identical scores:  ${sameScores}`)
    console.log(`    flower top: ${flower.results[0].name} @ ${flower.results[0].score}`)
    console.log(`    leaf   top: ${leaf.results[0].name} @ ${leaf.results[0].score}`)
    if (sameScores) {
      console.log('    => organ has NO observable effect on Pl@ntNet output for this photo')
    } else {
      console.log('    => organ DOES change Pl@ntNet output')
    }

    // The parameter must at least travel correctly, whatever Pl@ntNet does.
    expect(flower.sentOrgans).toEqual(['flower'])
    expect(leaf.sentOrgans).toEqual(['leaf'])
    expect(flower.echoedOrgans).toEqual(['flower'])
    expect(leaf.echoedOrgans).toEqual(['leaf'])

    assertClean(diagnostics, 'organ')
    await context.close()
  })

  test('7. the row is really in Supabase, and a repeat is refused', async ({ browser }) => {
    const supabase = await supabaseClient()

    // The row check 5 wrote, read straight from Postgres.
    const { data: rows, error } = await supabase
      .from('catches')
      .select('*')
      .eq('user_id', walkthroughUser)

    expect(error, 'catches query succeeded').toBeNull()
    expect(rows, 'exactly one row for the walkthrough user').toHaveLength(1)

    const row = rows[0]
    console.log(
      `  [supabase] ${row.scientific_name} type=${row.type} place=${row.place_id} ` +
        `lat=${row.lat} lng=${row.lng} confidence=${row.confidence}`,
    )

    expect(row.scientific_name).toBe(EXPECTED_SPECIES)
    expect(row.type, 'introduced species stored as a threat report').toBe(EXPECTED_TYPE)
    expect(row.place_id).toBe(PLACE_ID)
    expect(Number(row.lat)).toBeCloseTo(OREGON.latitude, 4)
    expect(Number(row.lng)).toBeCloseTo(OREGON.longitude, 4)

    // Same user, same species, same place, through the UI again.
    const { context, page, diagnostics } = await openApp(browser, {
      userId: walkthroughUser,
      geolocation: OREGON,
    })

    await chooseOrganAndPhoto(page, 'flower')
    await identify(page)
    await confirmCatch(page)

    await expect(page.getByRole('heading', { name: 'Already in your dex' })).toBeVisible({
      timeout: 90_000,
    })

    const duplicate = diagnostics.nonOk.find((entry) => entry.url.endsWith('/api/catches'))
    expect(duplicate, 'the duplicate attempt was refused').toBeTruthy()
    expect(duplicate.status).toBe(409)

    // And no second row landed.
    const { data: after } = await supabase
      .from('catches')
      .select('id')
      .eq('user_id', walkthroughUser)
    expect(after, 'still exactly one row').toHaveLength(1)

    console.log('  [dedup] 409 DUPLICATE_CATCH surfaced in the UI; row count unchanged')
    assertClean(diagnostics, 'dedup')
    await context.close()
  })
})

// ---------------------------------------------------------------------------
// Teardown — remove every row this run created, and nothing else
// ---------------------------------------------------------------------------

test.afterAll(async () => {
  if (runUserIds.size === 0) return

  const supabase = await supabaseClient()
  const ids = [...runUserIds]

  const { data: mine, error } = await supabase.from('catches').select('id, user_id').in('user_id', ids)
  if (error) {
    console.log(`  [cleanup] could not list this run's rows: ${error.message}`)
    return
  }

  if (mine.length === 0) {
    console.log('  [cleanup] nothing to remove')
  } else {
    // Deleting by the ids we just read, all of which carry a user_id this run
    // generated. Pre-existing demo rows cannot match — their user ids do not
    // contain this run's timestamp.
    const { error: deleteError } = await supabase
      .from('catches')
      .delete()
      .in('id', mine.map((row) => row.id))

    console.log(
      deleteError
        ? `  [cleanup] delete failed: ${deleteError.message}`
        : `  [cleanup] removed ${mine.length} row(s) written by this run`,
    )
  }

  const { count } = await supabase.from('catches').select('*', { count: 'exact', head: true })
  console.log(`  [cleanup] rows remaining in catches: ${count}`)
})
