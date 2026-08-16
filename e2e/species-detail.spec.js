// The expanded species card, driven through a real browser.
//
// Unlike photocapture.spec.js this mocks every route, so it costs no Pl@ntNet
// quota and writes nothing to Supabase — the same trade capture-threshold.spec.js
// makes. What it needs a browser for is the parts that only exist there: a
// native <dialog>'s three close paths, and the fact that the grid renders one
// tile per sighting rather than one per species.
//
// The fixtures are shaped around the cases that are easy to get wrong: two
// sightings of one species in two different regions, one of them with no photo
// (a catch logged before photo storage existed), and two other users' threat
// reports — one close enough to list, one far enough to exclude.

import { test, expect } from '@playwright/test'

// localStorage key from client/src/session.js.
const USER_ID_KEY = 'oregonhacks.userId'
const USER = 'usr_speciesdetail'

// Both sightings are the same taxon, so groupBySpecies collapses them into one
// card — and the expanded view has to un-collapse them again.
const OWN_CATCHES = [
  {
    id: 'own_spring',
    taxon_id: 111,
    scientific_name: 'Berberis aquifolium',
    common_name: 'Oregon grape',
    type: 'catch',
    lat: 44.05,
    lng: -123.08,
    place_id: 10,
    place_name: 'Oregon, US',
    photo_url: 'https://placehold.co/400x300/2d5016/fff.jpg',
    created_at: '2026-04-12T10:00:00Z',
  },
  {
    // No photo: logged before the catch-photos bucket existed. The grid has to
    // show it as a sighting rather than dropping it or breaking an <img>.
    id: 'own_winter',
    taxon_id: 111,
    scientific_name: 'Berberis aquifolium',
    common_name: 'Oregon grape',
    type: 'catch',
    lat: 33.45,
    lng: -112.07,
    place_id: 40,
    place_name: 'Arizona, US',
    photo_url: null,
    created_at: '2026-01-08T10:00:00Z',
  },
]

const ALL_CATCHES = [
  ...OWN_CATCHES,
  {
    // ~3km from the Oregon sighting: inside NEARBY_RADIUS_KM.
    id: 'other_near',
    taxon_id: 222,
    scientific_name: 'Rubus armeniacus',
    common_name: 'Armenian Blackberry',
    type: 'threat_report',
    lat: 44.07,
    lng: -123.1,
    place_id: 10,
    place_name: 'Oregon, US',
    photo_url: null,
    created_at: '2026-08-01T10:00:00Z',
  },
  {
    // Another continent. Present in the same response, and must not be listed.
    id: 'other_far',
    taxon_id: 333,
    scientific_name: 'Ailanthus altissima',
    common_name: 'Tree of heaven',
    type: 'threat_report',
    lat: 10,
    lng: 10,
    place_id: 99,
    place_name: 'Nowhere',
    photo_url: null,
    created_at: '2026-08-01T10:00:00Z',
  },
]

const STATUS = {
  establishmentMeans: 'native',
  placeName: 'Oregon, US',
  classification: 'catch',
  conservationStatus: { statusName: 'Least Concern', authority: 'IUCN' },
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [USER_ID_KEY, USER])

  // ?userId= is the catalogue's own list; the bare call is the everyone-list
  // the nearby-threats section reads. One route, two answers — same as the
  // real endpoint.
  await page.route('**/api/catches*', (route) => {
    const url = new URL(route.request().url())
    const catches = url.searchParams.get('userId') ? OWN_CATCHES : ALL_CATCHES
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ catches }),
    })
  })

  await page.route('**/api/species/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STATUS),
    }),
  )
})

const openCard = async (page) => {
  const card = page.getByRole('button', { name: /Oregon grape/ })
  await expect(card).toBeVisible()
  await card.click()
  const dialog = page.locator('dialog.species-detail')
  await expect(dialog).toBeVisible()
  return { card, dialog }
}

test.describe('expanded species card', () => {
  test('shows every sighting, with its own photo and location', async ({ page }) => {
    await page.goto('/catalogue')
    const { dialog } = await openCard(page)

    await expect(dialog.getByRole('heading', { name: '2 sightings' })).toBeVisible()
    await expect(dialog.locator('.sighting')).toHaveCount(2)

    // One real photo, one placeholder — not one broken image.
    await expect(dialog.locator('img.sighting-photo')).toHaveCount(1)
    await expect(dialog.locator('.sighting-photo.is-missing')).toHaveCount(1)

    // Per-photo location, as a label rather than a map per tile.
    await expect(dialog.getByText('44.050, -123.080')).toBeVisible()
    await expect(dialog.getByText('33.450, -112.070')).toBeVisible()
    await expect(dialog.getByText('Arizona, US')).toBeVisible()
  })

  test('shows the native/invasive verdict in the region it was found', async ({ page }) => {
    await page.goto('/catalogue')
    const { dialog } = await openCard(page)

    await expect(dialog.getByText(/is recorded as/)).toBeVisible()
    await expect(dialog.getByText(/Oregon, US/).first()).toBeVisible()
  })

  test('derives season from the catch date and says weather is not captured', async ({ page }) => {
    await page.goto('/catalogue')
    const { dialog } = await openCard(page)

    // On the sighting tiles themselves, beside the date, rather than repeated
    // in a list of their own. April is spring and January is winter — both
    // north of the equator, which is what the stored latitude settles.
    await expect(dialog.getByText(/Apr 12, 2026 · Spring/)).toBeVisible()
    await expect(dialog.getByText(/Jan 8, 2026 · Winter/)).toBeVisible()

    // The absence is stated rather than filled in with a plausible number.
    await expect(
      dialog.getByText(/Weather at the time of the catch is not recorded/),
    ).toBeVisible()
  })

  test('separates a real conservation assessment from uncalibrated rarity', async ({ page }) => {
    await page.goto('/catalogue')
    const { dialog } = await openCard(page)

    // iNaturalist's assessment is real data and is shown as such.
    await expect(dialog.getByText('Least Concern')).toBeVisible()
    // The rare/common banding never had thresholds set, and says so.
    await expect(dialog.getByText('Not calibrated')).toBeVisible()
  })

  test('lists nearby threat reports and excludes distant ones', async ({ page }) => {
    await page.goto('/catalogue')
    const { dialog } = await openCard(page)

    await expect(dialog.getByText('Armenian Blackberry')).toBeVisible()
    await expect(dialog.getByText('Tree of heaven')).toHaveCount(0)
    // The user's own catches are in the same response and are not reports.
    await expect(dialog.locator('.threat-list li')).toHaveCount(1)
  })

  test('closes on Escape, the close button, and a tap outside', async ({ page }) => {
    await page.goto('/catalogue')

    const { dialog } = await openCard(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    await openCard(page)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()

    // A click landing on the <dialog> element itself is a click on the
    // backdrop; the content lives in a child that stops it.
    await openCard(page)
    await page.mouse.click(5, 5)
    await expect(dialog).toBeHidden()
  })
})
