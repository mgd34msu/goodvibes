import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright harness, the phone-viewport (390x844) proof standard this repo's
 * visual proofs defer to, plus a desktop project to catch regressions.
 *
 * WHAT IS SERVED: a production build of THIS repo (`vite build`, then `vite preview`),
 * the same bundle the release ships, not the vite dev server. The dev server hands
 * each page ~340 separately transformed modules; on a 4-vCPU CI runner with four
 * browsers loading them at once, the app took ~11 s to boot, past the 10 s expect
 * timeout (CI run 36775763838, tailscale-serve.e2e.ts:100). A build is a handful of
 * chunks, boots in well under a second, and is what users actually run.
 *
 * HERMETIC BY CONSTRUCTION: the preview serves on a dedicated port (4318,
 * deliberately NOT 3421 or 4444) and points its /api proxy at a
 * local STUB (scripts/e2e-daemon-stub.ts, port 59991) that answers every request with
 * a deliberate 503 { code: 'E2E_STUB' }, never a real daemon. In practice the stub is
 * almost never reached: every test installs an in-page mock (installMockDaemon /
 * installChatMockDaemon) that intercepts the wire in the browser and answers from a
 * seeded fixture. The stub exists for the one structural exception, requests made
 * while a REAL service worker controls the page (the PWA specs), which Playwright
 * page routing cannot see, so nothing ever dies as a refused connection and a clean
 * run's webServer log is silent. No real daemon, no real network beyond the local
 * preview server, no port coordination.
 */

const WEB_PORT = Number(process.env.GOODVIBES_E2E_PORT ?? 4318);
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Where the one build lands. The service worker caches only built, hashed assets,
 * which is also what lets pwa-offline.e2e.ts prove the app opens offline.
 * GOODVIBES_E2E_DIST moves it, so two local runs on different ports do not
 * empty each other's build.
 */
const E2E_DIST = process.env.GOODVIBES_E2E_DIST ?? 'e2e/.artifacts/e2e-dist';

/** Env for the build and every preview: the daemon is the deliberate-503 stub. */
const PREVIEW_ENV = {
  GOODVIBES_DAEMON_BASE_URL: 'http://127.0.0.1:59991',
  GOODVIBES_WEBUI_BINDING_DISCOVERY: '0',
  // Force the config's settings/CLI probes to no-op deterministically.
  GOODVIBES_TUI_SETTINGS_PATH: '/nonexistent/goodvibes-e2e-settings.json',
};

export default defineConfig({
  testDir: './e2e',
  // Files are named *.e2e.ts (NOT *.spec.ts) so `bun test`, which globs *.spec.ts /
  // *.test.ts across the repo, never tries to run these Playwright suites.
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.artifacts/test-output',
  // Every test gets its own browser context and its own in-page mock daemon, so
  // tests are independent and run in parallel, file by file and within a file.
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
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        // Pin the exact hero viewport the brief specifies, overriding the device default.
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
  webServer: [
    {
      // The deliberate answer for requests the in-page mocks cannot intercept
      // (see the header comment). Must start before the preview so the proxy
      // target is never a dead port.
      command: 'bun scripts/e2e-daemon-stub.ts',
      url: 'http://127.0.0.1:59991/__stub-alive',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build once (a few seconds), then serve it. Its /api proxy (vite's preview
      // reuses server.proxy) points at the stub, explicitly NOT the real control
      // plane (3421) or web (4444/3423) ports.
      command: `bun run generated:check && bunx vite build --outDir ${E2E_DIST} --emptyOutDir && bunx vite preview --outDir ${E2E_DIST} --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: BASE_URL,
      timeout: 120_000,
      // Never adopt a leftover preview: it would serve an older build than the one this run is meant to test.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: PREVIEW_ENV,
    },
  ],
});
