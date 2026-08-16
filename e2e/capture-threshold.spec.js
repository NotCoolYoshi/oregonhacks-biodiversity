// The confidence gate in PhotoCapture, driven by a stubbed /api/identify.
//
// This file deliberately breaks the convention set by photocapture.spec.js,
// which mocks nothing on principle. The reason is coverage, not convenience:
// the gate's branches are selected by the *top score*, and the only real photo
// this repo has identifies at 0.2375. Every real-stack run therefore takes the
// same path — four retries, then settle — and the branch that matters most in
// practice, a decent photo clearing 0.75 on the first try, is unreachable from
// there. Getting it honestly would mean a fixture that Pl@ntNet scores above
// 0.75 and keeps scoring above 0.75, which is a promise about someone else's
// model that no fixture can make.
//
// So: the transport is stubbed, and what is under test is entirely ours — which
// screen renders, what the attempt counter does, which result the ladder keeps.
// photocapture.spec.js still covers the real integration end to end; this
// covers the decisions that integration cannot be steered into making.
//
// Costs no Pl@ntNet quota and writes no database rows, so unlike its sibling it
// is free to run as often as you like.

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test, expect } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))

// Any readable image works — the response never depends on it. Reusing the
// real fixture avoids a second binary in the repo.
const PHOTO = resolve(HERE, 'fixtures/scotch-broom.jpg')

// Mirrors the constants in client/src/views/PhotoCapture.jsx.
const MAX_ATTEMPTS = 5

/** One /api/identify result, shaped exactly as server/src/services/plantnet.js maps it. */
const candidate = (scientificName, score, extra = {}) => ({
  score,
  scientificName,
  genus: null,
  family: 'Berberidaceae',
  commonNames: [],
  inatTaxonId: null,
  gbifId: scientificName,
  imageUrl: null,
  ...extra,
})

const identifyOk = (results, source = 'plantnet') => ({
  query: { imageCount: 1, organs: ['flower'] },
  bestMatch: results[0]?.scientificName ?? null,
  results,
  source,
  remainingRequests: 400,
})

/** The species-status response, so status-preview can render without iNaturalist. */
const statusOk = (scientificName, classification = 'catch') => ({
  taxonId: 1,
  scientificName,
  commonName: null,
  establishmentMeans: classification === 'catch' ? 'native' : 'introduced',
  classification,
  placeName: 'Oregon',
  conservationStatus: null,
})

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const retryHeading = (page) => page.getByRole('heading', { name: /Not confident enough/ })

/** Pick an organ, attach the photo, and fire the first identify. */
async function startCapture(page, organ = 'flower') {
  await page.goto('/capture')
  await page.locator(`input[name="organ"][value="${organ}"]`).check()
  await page.locator('input[type="file"]').setInputFiles(PHOTO)
  await page.getByRole('button', { name: 'Identify this plant' }).click()
}

/** From the retry screen, supply another photo and identify again. */
async function retryWithAnotherPhoto(page) {
  await page.getByRole('button', { name: 'Take another photo' }).click()
  await page.locator('input[type="file"]').setInputFiles(PHOTO)
  await page.getByRole('button', { name: 'Identify this plant' }).click()
}

test.describe('confidence gate', () => {
  test('a photo at or over 75% commits immediately, with no retry screen', async ({ page }) => {
    let calls = 0
    await page.route('**/api/identify', (route) => {
      calls++
      return json(route, identifyOk([
        candidate('Mahonia aquifolium', 0.8734),
        candidate('Mahonia nervosa', 0.0912),
      ], 'mock'))
    })
    await page.route('**/api/species/**', (route) => json(route, statusOk('Mahonia aquifolium')))

    await startCapture(page)

    // Straight to status-preview: the user is never asked to choose or retake.
    await expect(page.getByRole('heading', { name: 'Mahonia aquifolium' })).toBeVisible()
    await expect(retryHeading(page)).toHaveCount(0)
    await expect(page.locator('.capture-verdict')).toContainText('Native')
    await expect(page.locator('.capture')).toContainText('87% match')
    expect(calls, 'a confident photo is identified exactly once').toBe(1)

    // Mock data has to announce itself somewhere, and the candidate list that
    // used to carry the warning is gone.
    await expect(page.locator('.capture')).toContainText('mock identification data')
  })

  test('the ladder settles for the best result seen, not the most recent', async ({ page }) => {
    // Attempt 2 is the strongest; 3 through 5 are worse. None clear 0.75.
    const scores = [0.2, 0.6, 0.11, 0.15, 0.12]
    const names = ['First sp', 'Best sp', 'Third sp', 'Fourth sp', 'Last sp']
    let calls = 0

    await page.route('**/api/identify', (route) => {
      const index = calls++
      return json(route, identifyOk([candidate(names[index], scores[index])]))
    })
    await page.route('**/api/species/**', (route) => json(route, statusOk('Best sp', 'threat_report')))

    await startCapture(page)

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await expect(retryHeading(page)).toBeVisible()
      await expect(page.locator('.capture')).toContainText(`Attempt ${attempt} of ${MAX_ATTEMPTS}`)
      await retryWithAnotherPhoto(page)
    }

    // Attempt 2's species, three attempts after it was seen.
    await expect(page.getByRole('heading', { name: 'Best sp' })).toBeVisible()
    await expect(page.locator('.capture')).toContainText('60% match')
    await expect(page.locator('.capture')).toContainText(`best of ${MAX_ATTEMPTS} photos`)
    expect(calls).toBe(MAX_ATTEMPTS)
  })

  test('the running best is shown while the ladder is still climbing', async ({ page }) => {
    let calls = 0
    await page.route('**/api/identify', (route) => {
      const index = calls++
      return json(route, identifyOk([candidate(index === 0 ? 'Early sp' : 'Later sp', index === 0 ? 0.44 : 0.12)]))
    })

    await startCapture(page)
    await expect(page.locator('.capture')).toContainText('Closest so far')
    await expect(page.locator('.capture')).toContainText('44%')

    // A worse second attempt must not displace it.
    await retryWithAnotherPhoto(page)
    await expect(page.locator('.capture')).toContainText('Attempt 2 of 5')
    await expect(page.locator('.capture')).toContainText('Early sp')
    await expect(page.locator('.capture')).toContainText('44%')
  })

  test('LOW_CONFIDENCE spends an attempt instead of ending the flow', async ({ page }) => {
    // The server throws this rather than returning a thin result list, so it
    // arrives as a rejection — but it means the same thing as a weak score and
    // belongs on the same ladder.
    let calls = 0
    await page.route('**/api/identify', (route) => {
      calls++
      return json(route, { error: 'No confident match. Closest guess was X at 4%', code: 'LOW_CONFIDENCE' }, 404)
    })

    await startCapture(page, 'leaf')

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await expect(retryHeading(page)).toBeVisible()
      await expect(page.locator('.capture')).toContainText(`Attempt ${attempt} of ${MAX_ATTEMPTS}`)
      // Nothing was ever returned, so there is no best to advertise.
      await expect(page.locator('.capture')).not.toContainText('Closest so far')
      await retryWithAnotherPhoto(page)
    }

    // Five rejections and no candidate to settle for: the only honest outcome.
    await expect(page.getByRole('heading', { name: `No match after ${MAX_ATTEMPTS} photos` })).toBeVisible()
    expect(calls, 'the ladder stops asking at five').toBe(MAX_ATTEMPTS)

    // Starting over is a new session, not attempt six.
    await page.getByRole('button', { name: 'Start over' }).click()
    await page.locator('input[type="file"]').setInputFiles(PHOTO)
    await page.getByRole('button', { name: 'Identify this plant' }).click()
    await expect(page.locator('.capture')).toContainText(`Attempt 1 of ${MAX_ATTEMPTS}`)
  })

  test('quota exhaustion skips the ladder entirely', async ({ page }) => {
    // Another photo cannot fix this one, so it must not cost attempts or ask
    // for a retake — the distinction the ladder exists to preserve.
    let calls = 0
    await page.route('**/api/identify', (route) => {
      calls++
      return json(route, { error: 'Daily quota exhausted', code: 'QUOTA_EXCEEDED' }, 429)
    })

    await startCapture(page)

    await expect(page.getByRole('heading', { name: 'Out of identifications for today' })).toBeVisible()
    await expect(retryHeading(page)).toHaveCount(0)
    expect(calls, 'no retry storm against a quota wall').toBe(1)
  })

  test('tips rotate and never repeat back to back', async ({ page }) => {
    await page.route('**/api/identify', (route) =>
      json(route, { error: 'nothing recognised', code: 'NO_MATCH' }, 404))

    await startCapture(page)

    const tips = []
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await expect(retryHeading(page)).toBeVisible()
      tips.push((await page.locator('.capture-note').first().textContent()).trim())
      if (attempt < MAX_ATTEMPTS - 1) await retryWithAnotherPhoto(page)
    }

    console.log(`  [tips] ${tips.join(' | ')}`)
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i], 'a tip repeated back to back').not.toBe(tips[i - 1])
    }
    expect(new Set(tips).size, 'every retry gave different advice').toBe(tips.length)
  })
})
