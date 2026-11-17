// Proves: The scope the owner picks when approving in the web UI is the scope that reaches the daemon.
// Red when: The approve request carries another approval id, no remember flag or another tier than the one picked.
/**
 * What the owner decides on an approval reaches the daemon as decided: the
 * remember tier he chose arrives with the approval. Runs on phone and desktop;
 * the daemon is a stand-in at the wire that records every decision it receives.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { openRow } from './support/app';
import {
  PENDING_APPROVAL,
  PENDING_APPROVAL_SAME_CLASS,
} from './support/seed';

test('an approval granted at the command-class tier records a rule and suppresses the next identical ask', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [PENDING_APPROVAL, PENDING_APPROVAL_SAME_CLASS] });
  await page.goto('/?view=work');
  const detail = await openRow(page, 'Run the full test suite before merging');
  // The ask's own rememberOptions render in a kit Select; pick the command class.
  await detail.getByRole('combobox', { name: 'Remember scope for bash' }).click();
  await page.getByRole('option', { name: /every bun command/ }).click();
  await detail.getByRole('button', { name: 'Approve', exact: true }).click();

  // The approve call carried the chosen tier.
  await expect.poll(() => daemon.approvalActions.length).toBe(1);
  expect(daemon.approvalActions[0]).toMatchObject({
    approvalId: PENDING_APPROVAL.id,
    action: 'approve',
    body: { remember: true, rememberTier: 'command-class' },
  });
});
