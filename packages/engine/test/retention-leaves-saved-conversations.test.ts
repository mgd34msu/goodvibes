// Proves: The start-up and six-hourly retention sweeps run over the saved-conversation directory and delete the owner's conversations.
// Red when: A retention sweep root resolves to the sessions directory instead of sessions/agents/, or a new registry entry or housekeeping step covers the saved conversations.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSurface } from '../platform/src/platform/runtime/session-surface.ts';
import { persistConversation } from '../platform/src/platform/runtime/session-persistence.ts';
import { writeRecoveryFile } from '../platform/src/platform/runtime/session-recovery.ts';
import { runAppendOnlyRetentionSweep } from '../platform/src/platform/runtime/retention/append-only-registry.ts';
import { runDurabilityHousekeeping } from '../platform/src/platform/runtime/durability-housekeeping.ts';
import { SessionManager } from '../platform/src/platform/sessions/manager.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Every file under `dir` gets a modification time `days` in the past: the clock is the test's. */
function ageTree(dir: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) ageTree(path, days);
    else utimesSync(path, when, when);
  }
}

test('sixty-day-old saved conversations survive both sweeps while an old agent journal beside them is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-retention-'));
  roots.push(root);
  const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory: join(root, 'project'), homeDirectory: join(root, 'home') });
  const first = [{ role: 'user', content: 'plan the migration' }, { role: 'assistant', content: 'three steps' }];
  const second = [{ role: 'user', content: 'review the parser' }, { role: 'assistant', content: 'two issues' }];
  persistConversation('aaaa1111', { messages: first }, 'model-a', 'provider-a', 'migration', { surface });
  persistConversation('bbbb2222', { messages: second }, 'model-a', 'provider-a', 'parser', { surface });
  mkdirSync(surface.agentJournalsDir, { recursive: true });
  const journal = join(surface.agentJournalsDir, 'agent-0001.jsonl');
  writeFileSync(journal, `${JSON.stringify({ role: 'assistant', content: 'agent step' })}\n`);
  expect(writeRecoveryFile({ messages: first }, 'aaaa1111', 'migration', { surface })).toBe(true);
  ageTree(join(root, 'project'), 60);

  // The roots the composition passes (durability-services), default policy.
  runAppendOnlyRetentionSweep({ workingDirectory: surface.workingDirectory, surfaceRoot: surface.surfaceRoot, homeDirectory: surface.homeDirectory });
  runDurabilityHousekeeping({ surface, currentSessionId: () => null });

  const sessions = new SessionManager(surface.workingDirectory, { surface });
  expect(sessions.list().map((entry) => entry.name).sort()).toEqual(['aaaa1111', 'bbbb2222']);
  expect(sessions.load('aaaa1111').messages).toEqual(first);
  expect(sessions.load('bbbb2222').messages).toEqual(second);
  // The control: the sweep did run over this tree.
  expect(existsSync(journal)).toBe(false);
});
