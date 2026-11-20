// Proves: The scope the owner picks when approving in the web UI is the scope that reaches the daemon.
// Red when: The approve request carries another approval id, no remember flag or another tier than the one picked.

/**
 * What the owner decides on an approval reaches the daemon as decided, against
 * a real daemon started from source: a chat turn asks to run `bun --version`;
 * on the ask in that chat the owner picks "Any bun command in this project"
 * (not the default tier) and allows it. The daemon's own approval record and
 * its remembered rules are read back. Runs on phone and desktop.
 */
import { test, expect } from '@playwright/test';
import { ownerPairingLink, startRealDaemon } from './support/daemon';

type ApprovalRow = { id?: string; status?: string; request?: { tool?: string }; decision?: { rememberTier?: string; remember?: boolean } };

test('an approval granted at the command-class tier reaches the daemon with that tier and records its rule', async ({ page }) => {
  const daemon = await startRealDaemon({ commands: [{ marker: 'E2ESCOPE', command: 'bun --version', answer: 'Ran bun.' }] });
  try {
    const link = await ownerPairingLink(daemon);
    const approvals = async (): Promise<ApprovalRow[]> => {
      const listed = (await daemon.api(daemon.ownerToken, 'GET', '/api/approvals')).body as { approvals?: ApprovalRow[] } | ApprovalRow[];
      return Array.isArray(listed) ? listed : listed.approvals ?? [];
    };
    const chat = await daemon.api(link.token, 'POST', '/api/companion/chat/sessions', { title: 'approval scope' });
    const sessionId = (chat.body as { session?: { id?: string }; id?: string }).session?.id ?? (chat.body as { id?: string }).id ?? '';
    expect(sessionId).not.toBe('');
    const sent = await daemon.api(link.token, 'POST', `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content: 'E2ESCOPE run bun --version', clientMessageId: crypto.randomUUID() });
    expect(sent.status).toBeLessThan(300);
    await expect.poll(async () => (await approvals()).filter((row) => row.status === 'pending' && row.request?.tool === 'exec').length).toBe(1);
    const asked = (await approvals()).find((row) => row.status === 'pending' && row.request?.tool === 'exec')!;

    await page.goto(`${daemon.baseUrl}/?view=chat&session=${encodeURIComponent(sessionId)}${link.fragment}`);
    await page.getByRole('button', { name: 'Don\'t ask again…' }).click();
    await page.getByRole('radio', { name: 'Any bun command in this project' }).check();
    await page.getByRole('button', { name: 'Allow and remember' }).click();

    // What reached the daemon: its approval record for that ask, and the rule it remembered.
    await expect.poll(async () => (await approvals()).find((row) => row.id === asked.id)?.status).toBe('approved');
    const decided = (await approvals()).find((row) => row.id === asked.id)!;
    expect(decided.decision).toMatchObject({ remember: true, rememberTier: 'command-class' });
    const rules = await daemon.invoke(daemon.ownerToken, 'permissions.rules.list');
    expect(rules.status).toBe(200);
    expect((rules.body as { rules?: { tier?: string; tool?: string; description?: string }[] }).rules).toEqual(
      [expect.objectContaining({ tier: 'command-class', tool: 'exec', description: expect.stringContaining('bun') })]);
  } finally {
    await daemon.stop();
  }
});
