/**
 * Push "Allow"/"Deny" hand-off: opening the deep link the service worker builds
 * for an approval action button (`#approval-action=…&approval-id=…`) scrubs the
 * fragment. Deny runs the real deny call; Allow only opens the approval so the
 * person sees what they are approving and confirms with the Approve button.
 */
import { test, expect, type Locator } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';

const approvalRow = (scope: Locator) => scope.locator('.gv-row', { hasText: /^Approve bash/ });

test('a Deny hand-off sends the deny call for the seeded approval and moves it to finished', async ({ page }) => {
  const daemon = await installMockDaemon(page);

  await page.goto('/?view=approvals-tasks#approval-action=deny&approval-id=appr-e2e-1');

  await expect.poll(() => daemon.approvalActions.map((a) => `${a.approvalId}:${a.action}`)).toEqual(['appr-e2e-1:deny']);
  await expect.poll(() => new URL(page.url()).hash).not.toContain('approval-action');
  await expect(approvalRow(page.getByRole('region', { name: 'Needs you' }))).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: 'Active and finished' }).click();
  await expect(approvalRow(page.getByRole('region', { name: 'Finished' }))).toHaveCount(1);
});

test('an Allow hand-off opens the approval without approving it, and Approve then sends the call', async ({ page }) => {
  const daemon = await installMockDaemon(page);

  await page.goto('/?view=approvals-tasks#approval-action=approve&approval-id=appr-e2e-1');

  await expect.poll(() => new URL(page.url()).hash).not.toContain('approval-action');
  const detail = page.getByRole('button', { name: 'Close approval' });
  await expect(detail).toBeVisible();
  // Opening the approval is not consent: no call has been made yet.
  expect(daemon.approvalActions).toEqual([]);
  await expect(approvalRow(page.getByRole('region', { name: 'Needs you' }))).toHaveCount(1);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => daemon.approvalActions.map((a) => `${a.approvalId}:${a.action}`)).toEqual(['appr-e2e-1:approve']);
});
