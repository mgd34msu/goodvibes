/**
 * Pairing tokens settings/security surface (pairing.tokens.*, platform 1.8.0):
 * list/rename/revoke per device, the migrate-this-browser affordance, and the
 * revoke-shared-token action, each destructive step gated by the real
 * ConfirmSheet with a plain-language consequence, never a bare click-to-destroy.
 *
 * The revoke proof is what the app sends: the confirm gates a
 * pairing.tokens.delete naming that device, and the operator's own session (a
 * different token) stays signed in. The mock daemon, not the app, turns a
 * revoked token into 401s, so that behaviour is the daemon's to prove.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, createMockPairingStore } from './support/mock-daemon';
import { only, PHONE, expectTappable, openSettings } from './support/app';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the object-destructuring form even with no fixtures used
test.beforeEach(({}, testInfo) => {
  only(testInfo, PHONE);
});

async function openPairingSettings(page: import('@playwright/test').Page): Promise<void> {
  await openSettings(page, 'devices');
  await expect(pairingPanel(page)).toBeVisible();
}

/**
 * The paired-devices panel itself. Device names are asserted inside it rather
 * than across the whole page: a device may be named after a thing the app also
 * names elsewhere, "Phone" is both a plausible device name and the navigation
 * entry for the phone node view, and a page-wide text match would then be
 * ambiguous, or worse, satisfied by the navigation while the list is empty.
 */
function pairingPanel(page: import('@playwright/test').Page) {
  return page.getByTestId('pairing-tokens');
}

test('lists one row per paired device, never a secret, and renames inline', async ({ page }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000 },
    { id: 'tok-laptop', name: 'Laptop', token: 'e2e-laptop-token', createdAt: 1_700_000_500_000 },
  ]);
  await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);

  await expect(pairingPanel(page).locator('.pairing-token-row')).toHaveCount(2);
  // Never a secret in this list.
  await expect(pairingPanel(page).getByText('e2e-phone-token')).toHaveCount(0);

  await page.getByRole('button', { name: 'Rename Phone' }).click();
  const input = page.locator('#pairing-token-rename-tok-phone');
  await input.fill('My Phone');
  await input.press('Enter');
  await expect.poll(() => pairingStore.tokens.find((t) => t.id === 'tok-phone')?.name).toBe('My Phone');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename My Phone' })).toBeVisible();
});

test('touch targets on the pairing tokens panel clear 44px at phone width', async ({ page }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000 },
  ]);
  await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);
  await expectTappable(page, '.pairing-token-row__revoke', 'revoke device');
  await expectTappable(page, '.pairing-tokens-legacy__actions button', 'give this browser its own token');
});

test('revoking a device sends pairing.tokens.delete for that device only after its confirm, and leaves this session signed in', async ({ page }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000 },
  ]);
  // The operator's own browser keeps the default seeded session token, unrelated
  // to the phone's token being revoked.
  const daemon = await installMockDaemon(page, { pairingStore });

  await openPairingSettings(page);
  const phoneRow = page.locator('.pairing-token-row', { hasText: 'Phone' });
  await phoneRow.getByRole('button', { name: /Revoke/ }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(pairingStore.tokens).toHaveLength(1);
  expect(daemon.invocations('pairing.tokens.delete')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect(pairingPanel(page).locator('.pairing-token-row')).toHaveCount(0);
  expect(daemon.invocations('pairing.tokens.delete')).toEqual([{ id: 'tok-phone' }]);
  expect(pairingStore.revokedTokenValues.has('e2e-phone-token')).toBe(true);

  // The operator's OWN session (a different token entirely) is unaffected: a
  // reload lands back in the signed-in shell with the settings dialog reopened
  // from its link, its data still loading.
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(pairingPanel(page)).toBeVisible();
});

test('migrate mints this browser its own token; revoke-shared runs only after its confirm', async ({ page }) => {
  const pairingStore = createMockPairingStore();
  const daemon = await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);
  const storedToken = () => page.evaluate(() => window.localStorage.getItem('goodvibes.webui.token'));
  const sharedToken = await storedToken();

  await page.getByRole('button', { name: 'Give this browser its own token' }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(daemon.invocations('pairing.tokens.migrate')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => daemon.invocations('pairing.tokens.migrate').length).toBe(1);
  // This browser now holds the newly minted token, not the shared one.
  await expect.poll(storedToken).not.toBe(sharedToken);
  expect(pairingStore.tokens.map((t) => t.token)).toContain(await storedToken());

  await page.getByRole('button', { name: 'Revoke the shared token' }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(pairingStore.legacySharedRevoked).toBe(false);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => pairingStore.legacySharedRevoked).toBe(true);
  await expect(page.getByRole('button', { name: 'Revoke the shared token' })).toHaveCount(0);
});
