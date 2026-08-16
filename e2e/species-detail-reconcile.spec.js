// The expanded card reconciling stored history against a live lookup.
//
// The bug this covers: the header badge read the row's stored `type` while the
// body text read a fresh status lookup, so a catch logged before the verdict
// became location-aware could render "Native — in your catalogue" above
// "recorded as unknown". Two sources, one card, no acknowledgement that they
// disagreed.
//
// Fully mocked, like the other detail spec — no Pl@ntNet quota, no Supabase
// writes. The point is the reconciliation logic, and that is entirely a
// function of what the two endpoints return.

import { test, expect } from '@playwright/test'

const USER_ID_KEY = 'oregonhacks.userId'
const USER = 'usr_reconcile'

/** A stored row, with the fields the card actually reads. */
const row = (over = {}) => ({
  id: 'row_1',
  taxon_id: 63603,
  scientific_name: 'Parkinsonia florida',
  common_name: 'Blue palo verde',
  type: 'catch',
  lat: 33.45,
  lng: -112.07,
  place_id: 10,
  place_name: 'Oregon',
  photo_url: null,
  created_at: '2026-08-15T10:00:00Z',
  ...over,
})

/** A live /status response. */
const status = (over = {}) => ({
  taxonId: 63603,
  scientificName: 'Parkinsonia florida',
  commonName: 'Blue palo verde',
  establishmentMeans: 'native',
  isNative: true,
  isInvasive: false,
  classification: 'catch',
  conservationStatus: null,
  placeId: 40,
  placeName: 'Arizona, US',
  placeSource: 'coordinates',
  ...over,
})

/**
 * @param rows      stored catches
 * @param statusRes live /status body, or null to make the lookup fail
 * @param place     live /places/resolve body, or null to make it fail
 */
async function mount(page, { rows, statusRes, place, delayStatus = 0 }) {
  await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [USER_ID_KEY, USER])

  await page.route('**/api/catches*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ catches: rows }),
    }),
  )

  await page.route('**/api/places/resolve*', (route) =>
    place
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(place) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"nope"}' }),
  )

  await page.route('**/api/species/**', async (route) => {
    if (delayStatus) await new Promise((r) => setTimeout(r, delayStatus))
    return statusRes
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(statusRes),
        })
      : route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"iNaturalist is unavailable"}' })
  })

  await page.goto('/catalogue')
  await page.getByRole('button', { name: /Blue palo verde/ }).click()
  const dialog = page.locator('dialog.species-detail')
  await expect(dialog).toBeVisible()
  return dialog
}

const AZ_PLACE = { placeId: 40, placeName: 'Arizona, US', adminLevel: 10 }
const OR_PLACE = { placeId: 10, placeName: 'Oregon, US', adminLevel: 10 }

test.describe('verdict reconciliation', () => {
  test('the reported bug: stored catch, live unknown — no silent contradiction', async ({ page }) => {
    // Exactly the pre-fix row: logged as a 'catch' against Oregon, but its own
    // coordinates are in Arizona and iNaturalist has no entry for it there.
    const dialog = await mount(page, {
      rows: [row({ type: 'catch', place_id: 10, place_name: 'Oregon' })],
      statusRes: status({
        establishmentMeans: 'unknown',
        isNative: null,
        isInvasive: false,
        classification: 'catch',
      }),
      place: AZ_PLACE,
    })

    // The header must NOT claim "Native" off a stored 'catch' — that
    // conflation is the bug. classify() files unknown as 'catch' too.
    await expect(dialog.locator('.capture-verdict > strong')).toHaveText(
      /Not on the local checklist/,
    )
    await expect(dialog.locator('.capture-verdict')).toHaveClass(/is-unknown/)
    await expect(dialog.getByText(/recorded as/)).toContainText('unknown')

    // Header and body now agree, so there is nothing to disclose here: stored
    // 'catch' and live classification 'catch' match.
    await expect(dialog.locator('.verdict-diverged')).toHaveCount(0)
  })

  test('a real divergence is disclosed, not silently resolved', async ({ page }) => {
    // Stored as an ordinary catch; iNaturalist now calls it introduced.
    const dialog = await mount(page, {
      rows: [row({ type: 'catch' })],
      statusRes: status({
        establishmentMeans: 'introduced',
        isNative: false,
        isInvasive: true,
        classification: 'threat_report',
      }),
      place: AZ_PLACE,
    })

    // Live wins the badge...
    await expect(dialog.locator('.capture-verdict > strong')).toHaveText(/Invasive here/)
    // ...but the stored answer is named and dated rather than dropped.
    const note = dialog.locator('.verdict-diverged')
    await expect(note).toBeVisible()
    await expect(note).toContainText('Logged as a catch')
    await expect(note).toContainText('Aug 15, 2026')
    await expect(note).toContainText('introduced')
  })

  test('stored history shows immediately while the lookup is in flight', async ({ page }) => {
    const dialog = await mount(page, {
      rows: [row({ type: 'threat_report' })],
      statusRes: status(),
      place: AZ_PLACE,
      delayStatus: 1500,
    })

    // Before the lookup lands: the stored answer, explicitly marked provisional
    // rather than presented as current fact.
    await expect(dialog.locator('.capture-verdict > strong')).toContainText('Reported as a threat')
    await expect(dialog.locator('.verdict-checking')).toBeVisible()

    // After it lands: reconciled to the live answer.
    await expect(dialog.locator('.capture-verdict > strong')).toContainText('Native here', {
      timeout: 10_000,
    })
    await expect(dialog.locator('.verdict-checking')).toHaveCount(0)
  })

  test('a failed lookup falls back to stored and says it is historical', async ({ page }) => {
    const dialog = await mount(page, {
      rows: [row({ type: 'catch' })],
      statusRes: null, // 502
      place: AZ_PLACE,
    })

    await expect(dialog.locator('.capture-verdict > strong')).toContainText('In your catalogue')
    await expect(dialog.getByText(/may be out of date/)).toBeVisible()
    // Nothing is claimed about nativity when nothing could be checked.
    await expect(dialog.locator('.verdict-diverged')).toHaveCount(0)
  })
})

test.describe('location reconciliation', () => {
  test('a stale place_name is corrected and the old one disclosed', async ({ page }) => {
    const dialog = await mount(page, {
      // Stored as Oregon (place 10) but the coordinates are in Arizona.
      rows: [row({ place_id: 10, place_name: 'Oregon' })],
      statusRes: status(),
      place: AZ_PLACE,
    })

    await expect(dialog.locator('.sighting-place')).toHaveText('Arizona, US')
    await expect(dialog.locator('.sighting-corrected')).toHaveText('Logged as Oregon')
  })

  test('a renamed-but-same place is refreshed without crying wolf', async ({ page }) => {
    // "Oregon" -> "Oregon, US" is the same place id spelled two ways. Treating
    // that as a disagreement would flag every correct row in the database.
    const dialog = await mount(page, {
      rows: [row({ lat: 44.05, lng: -123.08, place_id: 10, place_name: 'Oregon' })],
      statusRes: status({ placeId: 10, placeName: 'Oregon, US' }),
      place: OR_PLACE,
    })

    await expect(dialog.locator('.sighting-place')).toHaveText('Oregon, US')
    await expect(dialog.locator('.sighting-corrected')).toHaveCount(0)
  })

  test('an unresolvable coordinate keeps the stored place', async ({ page }) => {
    const dialog = await mount(page, {
      rows: [row({ place_name: 'Oregon' })],
      statusRes: status(),
      place: null, // /places/resolve 404s
    })

    await expect(dialog.locator('.sighting-place')).toHaveText('Oregon')
    await expect(dialog.locator('.sighting-corrected')).toHaveCount(0)
  })
})
