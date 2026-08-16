import { defineConfig } from '@playwright/test'

// End-to-end tests run against the REAL stack: real Pl@ntNet, real
// iNaturalist, real Supabase. Nothing upstream is mocked, because the point is
// to find out what actually happens across the integration — the unit suites
// in server/test and client/test already cover the mocked paths.
//
// Consequences, and why this config looks the way it does:
//
//   - Pl@ntNet's free tier allows 500 identifications a day and each test that
//     walks the flow spends one. Hence workers: 1 and no retries; a retrying
//     suite burns quota and writes duplicate rows.
//   - Tests share one live database, so they cannot run in parallel.
//   - A real identify round trip takes several seconds, so the timeouts are
//     generous compared with a mocked suite.
//
// The dev server is started as two entries rather than the root `npm run dev`.
// That script runs both halves through `concurrently`, which gives Playwright
// one process to health-check and one process to kill — it can report ready
// before the API is actually up, and killing the wrapper can leave the two
// node children orphaned holding ports 5001 and 5173. Two entries let
// Playwright wait on each port's own readiness and own each process directly.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',

  timeout: 150_000,
  expect: { timeout: 30_000 },

  fullyParallel: false,
  workers: 1,
  retries: 0,

  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
  },

  webServer: [
    {
      command: 'npm --prefix server run dev',
      url: 'http://localhost:5001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm --prefix client run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
