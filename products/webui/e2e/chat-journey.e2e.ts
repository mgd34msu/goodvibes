/**
 * Chat history is never silently dropped: a sent message reaches the daemon and
 * is stored; regenerating a reply and editing a question each keep the superseded
 * message, marked with why, beside the new one. Runs on phone and desktop against
 * a stateful daemon stand-in at the wire.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';

const FIRST_MESSAGE = 'Promises in JavaScript\nExplain how they work, including the microtask queue and async/await.';

test('a sent message is stored, and regenerating or editing keeps the superseded message instead of dropping it', async ({ page }) => {
  const daemon = await installChatMockDaemon(page);

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();

  // ── Send the first message ────────────────────────────────────────────────
  await composer.fill(FIRST_MESSAGE);
  await page.locator('.send-button').click();

  // The user bubble and the streamed-then-persisted assistant reply both land.
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect.poll(() => daemon.sessionIds().length).toBe(1);
  const [sessionId = ''] = daemon.sessionIds();
  const stored = (role: 'user' | 'assistant') => daemon.messagesOf(sessionId).filter((m) => m.role === role);
  expect(stored('user').map((m) => m.content)).toEqual([FIRST_MESSAGE]);

  // ── Regenerate: the prior response is superseded but RETAINED and viewable ──
  await page.locator('.message.assistant button[aria-label="Regenerate response"]').first().click();
  // The daemon keeps the prior response, superseded by the regeneration, beside the fresh one.
  await expect.poll(() => stored('assistant').map((m) => m.supersededReason ?? 'active'))
    .toEqual(['regenerate', 'active']);

  // ── Edit and branch: the original message is superseded but RETAINED ────────
  await page.locator('.message.user button[aria-label="Edit and resend message"]').first().click();
  const editArea = page.locator('textarea[aria-label="Edit message"]');
  await expect(editArea).toBeVisible();
  await editArea.fill('Explain JavaScript generators instead.');
  await page.locator('button[aria-label="Send edited message (Ctrl+Enter)"]').click();

  // The daemon holds the edited question as the active one and keeps the original, superseded by the edit.
  await expect.poll(() => stored('user').map((m) => [m.content, m.supersededReason ?? 'active'])).toEqual([
    [FIRST_MESSAGE, 'edit'],
    ['Explain JavaScript generators instead.', 'active'],
  ]);
});
