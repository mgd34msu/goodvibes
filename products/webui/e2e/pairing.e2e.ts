/**
 * QR pairing hand-off: opening a `#pair=<token>` link (what the terminal's
 * `goodvibes pair` QR encodes) signs the device in and scrubs the token from the
 * URL, so the credential never lingers in the address bar or history; and a late
 * refusal of the anonymous probe cannot sign the paired device back out.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';

test('a pairing link signs in and strips the token from the URL', async ({ page }) => {
  // Boot signed OUT (no seeded token): the fragment is the only way in.
  await installMockDaemon(page, { signedIn: false });

  // With a view the start-up URL rewrite keeps the fragment, so only the hand-off's own scrub can remove the token.
  await page.goto('/?view=chat#pair=paired-operator-token');

  // The shell reveals (the mock daemon reports the token as authenticated).
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.signed-out-gate')).toHaveCount(0);

  // The one-time token is gone from the URL fragment (history.replaceState).
  await expect
    .poll(() => new URL(page.url()).hash)
    .not.toContain('pair=');
});
