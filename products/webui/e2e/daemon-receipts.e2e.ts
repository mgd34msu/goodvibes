/**
 * Daemon receipts, the connect-time notices. The daemon holds undelivered
 * receipts (a crash restart, a self-update, a migration) and hands them over
 * ONCE, when control.status is called with receipts=peek and then receipts=ack on connect. The
 * webui surfaces each as a one-line dismissible notice, exactly once: a reload
 * reconnects and re-reads, but the daemon already marked them delivered, so
 * nothing re-shows.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { gotoView, expectNoHorizontalScroll } from './support/app';

// Reloads and returns only after the reconnect's receipts=peek call has been answered
// and the page has painted, so a zero-count assertion afterwards cannot pass merely because
// the app had not asked yet.
async function reloadAfterReconsume(page: Page): Promise<void> {
  const consumed = page.waitForResponse((response) => new URL(response.url()).searchParams.get('receipts') === 'peek');
  await page.reload();
  await consumed;
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('a receipt shows once on connect and never re-shows after a reconnect', async ({ page }) => {
  await installMockDaemon(page, {
    daemonReceipts: [
      { id: 'rcpt-crash', text: 'Daemon restarted after a crash at 14:03', at: 1_700_000_000_000 },
      { id: 'rcpt-update', text: 'Updated to 1.7.1', at: 1_700_000_100_000 },
    ],
  });
  await gotoView(page, 'sessions');

  const notices = page.locator('[data-testid="daemon-receipt"]');
  await expect(notices).toHaveCount(2);
  await expectNoHorizontalScroll(page);

  // Reload → the app reconnects and re-reads, but the daemon already
  // delivered these receipts, so none re-appear.
  await reloadAfterReconsume(page);
  await expect(page.locator('[data-testid="daemon-receipt"]')).toHaveCount(0);
});

test('a receipt is dismissible', async ({ page }) => {
  await installMockDaemon(page, {
    daemonReceipts: [{ id: 'rcpt-update', text: 'Updated to 1.7.1', at: 1_700_000_000_000 }],
  });
  await gotoView(page, 'sessions');

  const notice = page.locator('[data-testid="daemon-receipt"]', { hasText: 'Updated to 1.7.1' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: /Dismiss notice/ }).click();
  await expect(page.locator('[data-testid="daemon-receipt"]')).toHaveCount(0);
});

test('a feature announcement rides the same queue, linkifies its URL, and shows once', async ({ page }) => {
  await installMockDaemon(page, {
    daemonReceipts: [
      { id: 'ann-web', text: 'Reach this session from your phone: https://gv.example/s/abc123', at: 1_700_000_000_000 },
    ],
  });
  await gotoView(page, 'sessions');

  const notice = page.locator('[data-testid="daemon-receipt"]', { hasText: 'Reach this session from your phone' });
  await expect(notice).toBeVisible();
  const link = notice.getByRole('link', { name: 'https://gv.example/s/abc123' });
  await expect(link).toHaveAttribute('href', 'https://gv.example/s/abc123');

  // Reconnect (reload), the announcement was delivered, so it never re-shows.
  await reloadAfterReconsume(page);
  await expect(page.locator('[data-testid="daemon-receipt"]')).toHaveCount(0);
});

test('a daemon with no receipts shows no notice', async ({ page }) => {
  await installMockDaemon(page, { daemonReceipts: [] });
  await gotoView(page, 'sessions');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('[data-testid="daemon-receipt"]')).toHaveCount(0);
});
