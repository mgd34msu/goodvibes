// ============================================================================
// PLAYWRIGHT E2E TEST CONFIGURATION
// ============================================================================

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for GoodVibes E2E tests.
 *
 * Note: E2E testing for Electron apps requires special setup.
 * Tests use the _electron fixture to launch and interact with the app.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false, // Electron tests should run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Electron apps need single worker
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  timeout: 60000, // Electron apps need longer timeouts

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'electron',
      testMatch: '**/*.e2e.ts',
    },
  ],
});
