import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright harness for the web UI's browser journeys, on a phone viewport
 * (390x844) and a desktop one.
 *
 * WHAT IS SERVED: a production build of THIS repo (`vite build`, made once by
 * the global setup, e2e/support/build.ts), served by a REAL daemon started from
 * this checkout for each journey (e2e/support/daemon.ts): its own scratch home,
 * its own free loopback ports (never 3421 or the owner's running daemon), and the
 * web UI on the daemon's own origin, so the sign-in cookie and the daemon's
 * Origin checks are the ones a person meets. The only stand-in is the
 * conversation model at the HTTP wire, on loopback.
 */

export default defineConfig({
  testDir: './e2e',
  // Files are named *.e2e.ts (NOT *.spec.ts) so `bun test`, which globs *.spec.ts /
  // *.test.ts across the repo, never tries to run these Playwright suites.
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.artifacts/test-output',
  globalSetup: './e2e/support/build.ts',
  // Every journey starts its own daemon in its own home, so journeys are independent and run in parallel.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [['list'], ['html', { outputFolder: 'e2e/.artifacts/report', open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
