// Proves: A pairing link signs the device in and the operator token does not stay in the address bar or history.
// Red when: Opening #pair=<token> does not sign in, or the token is still in the URL afterwards.

/**
 * QR pairing hand-off against a real daemon started from source: the owner's
 * pairing link (pairing.handoff.create, what the terminal's pairing QR encodes)
 * opened in the web UI the daemon serves signs the device in, and the token is
 * in neither the address bar nor any entry of the tab's history.
 */
import { test, expect } from '@playwright/test';
import { ownerPairingLink, startRealDaemon } from './support/daemon';

test('a pairing link signs in and strips the token from the URL', async ({ page }) => {
  const daemon = await startRealDaemon();
  try {
    const link = await ownerPairingLink(daemon);
    // With a view the start-up URL rewrite keeps the fragment, so only the hand-off's own scrub can remove the token.
    await page.goto(`${daemon.baseUrl}/?view=chat${link.fragment}`);

    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.signed-out-gate')).toHaveCount(0);

    await expect.poll(() => page.url()).not.toContain('pair=');
    expect(page.url()).not.toContain(encodeURIComponent(link.token));
    // Every entry of the tab's history as Chromium keeps it, not only the address bar.
    const cdp = await page.context().newCDPSession(page);
    const { entries } = await cdp.send('Page.getNavigationHistory');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.url).not.toContain('pair=');
      expect(entry.url).not.toContain(encodeURIComponent(link.token));
    }
  } finally {
    await daemon.stop();
  }
});
