// Proves: The web UI served over plain http at an address other than this machine's loopback signs in, sends a message and shows the reply.
// Red when: The page calls a browser API that is withheld outside a secure context, such as crypto.randomUUID, and dies at a phone's network address.

/**
 * The address a phone on the local network opens the web UI at is plain http
 * and not loopback, so the browser treats the page as an insecure context and
 * withholds APIs such as crypto.randomUUID and the clipboard. Against a real
 * daemon started from source: the web UI is served at `web.publicBaseUrl`, a
 * network host name the browser resolves to the daemon's loopback listener (so
 * the page's origin is that host, not loopback), the phone's pairing code is
 * opened there, and the person sends a message and gets the reply.
 */
import { test, expect } from '@playwright/test';
import { ownerPairingLink, startRealDaemon } from './support/daemon';
import { NETWORK_HOST } from './support/network-host';

test('the web UI at a plain-http network address signs in from a pairing code, sends a message and shows the reply', async ({ page }) => {
  const daemon = await startRealDaemon({ publicHost: NETWORK_HOST });
  try {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    // The code a phone scans: made only because the daemon's web address reaches other devices.
    const link = await ownerPairingLink(daemon, { forThisMachine: false });
    await page.goto(`${daemon.publicUrl}/?view=chat${link.fragment}`);

    // The proof is about an insecure context: it cannot pass on a page the browser trusts.
    expect(new URL(page.url()).hostname).toBe(NETWORK_HOST);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);

    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.signed-out-gate')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message GoodVibes' }).fill('Hello from a phone on the network');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Noted.').first()).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await daemon.stop();
  }
});
