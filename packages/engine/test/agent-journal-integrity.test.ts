/** An agent's saved journal: an unreadable one is reported as unreadable, and lost writes are counted rather than silent. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '../platform/src/platform/agents/session.js';
import { readAgentSessionHistory } from '../platform/src/platform/agents/session-history.js';
import { resolveScopedDirectory } from '../platform/src/platform/runtime/surface-root.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function savedWorker() {
  const root = mkdtempSync(join(tmpdir(), 'agent-journal-')); roots.push(root);
  const sessions = resolveScopedDirectory(root, 'tui', 'sessions', 'agents');
  const session = new AgentSession('agent-saved', 'model', 'provider', { sessionsDir: sessions, stateDir: join(root, 'state') });
  session.conversation.addUserMessage('Read review.md.');
  session.conversation.addAssistantMessage('Done.');
  await session.dispose();
  return { root, sessions, session, request: { projectRoot: root, surfaceRoot: 'tui', agentId: session.agentId, assertCurrent() {} } };
}

test('a journal with a malformed line is reported unreadable; an absent one is not', async () => {
  const { request, session } = await savedWorker();
  const reasons: string[] = [];
  expect(await readAgentSessionHistory({ ...request, onUnreadable: (reason) => reasons.push(reason) })).toBeDefined();
  expect(reasons).toEqual([]);

  writeFileSync(session.sessionFile, readFileSync(session.sessionFile, 'utf8') + '{broken final journal row\n');
  expect(await readAgentSessionHistory({ ...request, onUnreadable: (reason) => reasons.push(reason) })).toBeUndefined();
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain('not valid JSON');

  reasons.length = 0;
  expect(await readAgentSessionHistory({ ...request, agentId: 'agent-never-ran', onUnreadable: (reason) => reasons.push(reason) })).toBeUndefined();
  expect(reasons).toEqual([]);
});

test('lines that could not be written are counted, so a journal that lost history is distinguishable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-journal-lost-')); roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const session = new AgentSession('agent-lossy', 'model', 'provider', { sessionsDir, stateDir: join(root, 'state') });
  expect(session.lostWriteCount).toBe(0);
  // The directory is replaced by a file, so every later append fails.
  rmSync(sessionsDir, { recursive: true, force: true });
  writeFileSync(sessionsDir, 'not a directory');
  session.appendMessage({ type: 'note' });
  session.appendMessage({ type: 'note' });
  expect(session.lostWriteCount).toBe(2);
  await session.dispose();
  expect(session.lostWriteCount).toBe(3);
});
