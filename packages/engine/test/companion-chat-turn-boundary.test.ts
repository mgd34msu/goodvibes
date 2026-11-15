/**
 * companion-chat-turn-boundary.test.ts, the webui gets a turn boundary too,
 * and only where the daemon can prove who is speaking.
 *
 * ── Why this surface needed its own wiring ────────────────────────────────
 *
 * `CompanionChatManager` runs its own turn loop rather than the Orchestrator's,
 * so the boundary wired into `Orchestrator.runTurn`, the one that fixed the
 * agent and the TUI together, did not reach it. The consequence was narrow and
 * bad: a message the owner typed in the webui never ended the previous turn's
 * untrusted-content window, so the friction removed everywhere else stayed
 * present on one of his three surfaces, and a page read an hour earlier still
 * counted against a message he was writing now.
 *
 * ── The rule this file pins ───────────────────────────────────────────────
 *
 * Attest only what you can prove. Three transports reach this manager and they
 * are not alike:
 *
 *  - The HTTP route (`POST /api/companion/chat/sessions/:id/messages`) sits
 *    behind the daemon's bearer-token auth. Holding that token IS being the
 *    owner, same credential the TUI and operator API use, so it attests, and
 *    the window resets.
 *  - The ntfy relay carries a topic. Anyone who learns the topic can publish to
 *    it, so it attests nothing and the window stays open.
 *  - Home Assistant carries a device id. A voice pipeline reports which speaker
 *    heard something, never who spoke, so it attests nothing either.
 *
 * The failure this asymmetry prevents is specific: a transport that could reset
 * the window on a stranger's message would let content that had just been read
 * erase the record of itself before the outward action it was trying to cause.
 * So "cannot tell" resolves to "not the owner", every time, and the cost of
 * being wrong in that direction is friction rather than a send.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { trackDisposables } from './_helpers/disposables.ts';
import { waitFor } from './_helpers/test-timeout.ts';
import {
  getProcessUntrustedContentLedger,
  resetProcessUntrustedContentLedgerForTests,
  withUntrustedContentScope,
} from '../platform/src/platform/security/untrusted-content.ts';
import { CompanionChatManager, companionChatContentScope } from '../platform/src/platform/companion/companion-chat-manager.ts';
import type { CompanionLLMProvider } from '../platform/src/platform/companion/companion-chat-manager.ts';

const disposables = trackDisposables();

function makeManager(options: { readonly gate?: Promise<void> | undefined } = {}): { manager: CompanionChatManager; completed: () => number } {
  const provider: CompanionLLMProvider = {
    async *chatStream() {
      await options.gate;
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done' };
    },
  };
  let completedTurns = 0;
  const manager = disposables.add(new CompanionChatManager({
    provider,
    eventPublisher: {
      publishEvent(event) { if (event === 'companion-chat.turn.completed') completedTurns += 1; },
    },
    gcIntervalMs: 999_999,
  }));
  return { manager, completed: () => completedTurns };
}

function recordAPageRead(): void {
  getProcessUntrustedContentLedger().record({
    surface: 'web-page',
    origin: 'https://news.example',
    at: new Date().toISOString(),
    content: 'text a stranger published',
  });
}

/** Whether the chat's own turn has read untrusted text (its turns run in the chat's scope). */
const exposed = (sessionId: string): boolean =>
  withUntrustedContentScope(companionChatContentScope(sessionId), () => getProcessUntrustedContentLedger().hasIngestedThisTurn());

beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });
afterEach(() => { resetProcessUntrustedContentLedgerForTests(); });

// The turn starts synchronously when an idle session accepts the message, so the
// ledger is read right after the post returns, before the turn can read anything.
describe('an authenticated owner message ends the previous turn', () => {
  test('a message the route attests resets the window', async () => {
    const { manager } = makeManager();
    const session = manager.createSession();
    recordAPageRead();
    expect(exposed(session.id)).toBe(true);

    await manager.postMessage(session.id, 'hello', '', { ownerDirect: true });
    expect(exposed(session.id)).toBe(false);
  });

  test('a message queued behind a running turn resets the window when its own turn starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, completed } = makeManager({ gate });
    const session = manager.createSession();
    await manager.postMessage(session.id, 'first', '', { ownerDirect: true });
    recordAPageRead();

    // Posted while the first turn runs: it waits, and the attestation must wait with it.
    await manager.postMessage(session.id, 'second', '', { ownerDirect: true });
    expect(exposed(session.id)).toBe(true);

    release();
    await waitFor(() => completed() === 2);
    expect(exposed(session.id)).toBe(false);
  });
});

describe('a relayed message does not', () => {
  test('a post with no attestation (ntfy, Home Assistant) leaves the window open', async () => {
    const { manager } = makeManager();
    const session = manager.createSession();
    recordAPageRead();

    await manager.postMessage(session.id, 'from a topic');
    expect(exposed(session.id)).toBe(true);
  });

  test('an explicit false is honoured', async () => {
    const { manager } = makeManager();
    const session = manager.createSession();
    recordAPageRead();

    await manager.postMessage(session.id, 'hello', '', { ownerDirect: false });
    expect(exposed(session.id)).toBe(true);
  });

  test('the wait-for-reply entry the relays use cannot attest', async () => {
    const { manager } = makeManager();
    const session = manager.createSession();
    recordAPageRead();

    await manager.postMessageAndWaitForReply(session.id, 'from a room', '', { timeoutMs: 5_000 });
    expect(exposed(session.id)).toBe(true);
  });
});

describe('the transports', () => {
  test('only the authenticated route attests; the relays name no attestation at all', async () => {
    const routes = await Bun.file(
      new URL('../platform/src/platform/companion/companion-chat-routes.ts', import.meta.url),
    ).text();
    expect(routes).toContain('ownerDirect: isOwnerRequest(req, context)');

    // Any expression, not just a literal true: a stranger's channel message that
    // can end the owner's turn could erase the record of what it just made the
    // assistant read. Comments may mention the word; code may not assign it.
    for (const relative of [
      '../platform/src/platform/daemon/surface-actions.ts',
      '../platform/src/platform/daemon/homeassistant-chat.ts',
      '../platform/src/platform/hosted-sessions/session-runtime.ts',
    ]) {
      const code = (await Bun.file(new URL(relative, import.meta.url)).text())
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      expect(code).not.toMatch(/ownerDirect\s*[:=]/);
    }
  });
});

describe('a chat turn is scoped to its own chat', () => {
  test('an owner message in one chat does not end another session\'s exposure window', async () => {
    const { manager } = makeManager();
    const session = manager.createSession();
    const ledger = getProcessUntrustedContentLedger();
    withUntrustedContentScope('principal:automation', () => {
      ledger.startTurn();
      ledger.record({ surface: 'web-page', origin: 'https://news.example', at: new Date().toISOString(), content: 'text a stranger published' });
    });

    await manager.postMessage(session.id, 'hello', '', { ownerDirect: true });
    expect(withUntrustedContentScope('principal:automation', () => ledger.hasIngestedThisTurn())).toBe(true);
    // What another session read does not count against this chat either.
    expect(exposed(session.id)).toBe(false);
  });
});
