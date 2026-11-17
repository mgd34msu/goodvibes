/**
 * A crash snapshot the person chose to keep is still offered at the next launch,
 * with the conversation it held, even when the kept session is the one they go
 * on working in: its live snapshot writes and its turn-end save neither replace
 * nor delete the kept one.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSurface, type SessionSurface } from '../platform/src/platform/runtime/session-surface.ts';
import { persistConversation } from '../platform/src/platform/runtime/session-persistence.ts';
import {
  checkRecoveryFile,
  deleteRecoveryFile,
  holdOfferedRecoverySnapshot,
  loadRecoveryConversation,
  releaseOfferedRecoverySnapshot,
  writeRecoveryFile,
} from '../platform/src/platform/runtime/session-recovery.ts';

const roots: string[] = [];
const held: { surface: SessionSurface; sessionId: string }[] = [];
afterEach(() => {
  for (const { surface, sessionId } of held.splice(0)) releaseOfferedRecoverySnapshot(surface, sessionId);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function surfaceIn(): SessionSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-crash-kept-'));
  roots.push(root);
  return createSessionSurface({ surfaceRoot: 'tui', workingDirectory: join(root, 'project'), homeDirectory: join(root, 'home') });
}

const SESSION = 'a1b2c3d4';
const crashed = [{ role: 'user', content: 'refactor the parser' }, { role: 'assistant', content: 'half way through the parser' }];
const live = [{ role: 'user', content: 'something else entirely' }];

/** The launch after the crash offers the snapshot; the person keeps it for later, as the start-up offer does. */
function crashThenKeep(surface: SessionSurface): void {
  expect(writeRecoveryFile({ messages: crashed }, SESSION, 'parser work', { surface })).toBe(true);
  const offered = checkRecoveryFile({ surface });
  expect(offered?.sessionId).toBe(SESSION);
  holdOfferedRecoverySnapshot(surface, SESSION);
  held.push({ surface, sessionId: SESSION });
}

/** What the next launch is offered, and the conversation it would restore. */
function nextLaunchOffer(surface: SessionSurface): Array<Record<string, unknown>> | null {
  const info = checkRecoveryFile({ surface });
  if (info === null) return null;
  return loadRecoveryConversation({ surface }, info.sessionId)?.messages ?? null;
}

test('the kept session goes on: its live snapshot and its turn-end save leave the kept snapshot for the next launch', () => {
  const surface = surfaceIn();
  crashThenKeep(surface);
  // The same session carries on in this launch: a prompt is accepted, then the turn ends with a clean save.
  expect(writeRecoveryFile({ messages: live }, SESSION, 'parser work', { surface })).toBe(true);
  persistConversation(SESSION, { messages: live }, 'model-a', 'provider-a', 'parser work', { surface });
  deleteRecoveryFile({ surface }, SESSION);

  expect(nextLaunchOffer(surface)).toEqual(crashed);
});

test('a turn-end save straight after keeping it does not delete the kept snapshot', () => {
  const surface = surfaceIn();
  crashThenKeep(surface);
  persistConversation(SESSION, { messages: live }, 'model-a', 'provider-a', 'parser work', { surface });
  deleteRecoveryFile({ surface }, SESSION);

  expect(nextLaunchOffer(surface)).toEqual(crashed);
});
