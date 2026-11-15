/** An agent's saved journal: an unreadable or incomplete one is reported as such, never as "no history". */
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

test('a journal that lost its final conversation entry is reported incomplete, not as no history', async () => {
  const { request, session } = await savedWorker();
  // Keep only the run's opening line, as when the final entry could not be written.
  writeFileSync(session.sessionFile, `${readFileSync(session.sessionFile, 'utf8').split('\n')[0]}\n`);
  const reasons: string[] = [];
  expect(await readAgentSessionHistory({ ...request, onUnreadable: (reason) => reasons.push(reason) })).toBeUndefined();
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain('incomplete');
});
