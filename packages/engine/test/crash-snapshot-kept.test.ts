// Proves: A crash snapshot the person chose to keep is replaced or deleted by the session carrying on, and the conversation it held is gone.
// Red when: The live snapshot write or the turn-end save and delete replaces or removes the kept snapshot.
// Proves: A crash in a later turn is taken for already saved and the turn in flight is lost, or a snapshot the turn-end save superseded is restored over the newer save.
// Red when: The comparison of a snapshot with its session's saved file goes the wrong way: a snapshot newer than the last save is hidden, or one a later save replaced is offered.
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
  checkRecoveryForSession,
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

test('a crash in a later turn is offered over the earlier save; once the turn-end save lands it is not', () => {
  const surface = surfaceIn();
  const turnOne = [{ role: 'user', content: 'refactor the parser' }, { role: 'assistant', content: 'first pass done' }];
  const turnTwo = [...turnOne, { role: 'user', content: 'now the tests' }, { role: 'assistant', content: 'half way through the tests' }];
  persistConversation(SESSION, { messages: turnOne }, 'model-a', 'provider-a', 'parser work', { surface });
  // Turn two is in flight when the process dies: its snapshot is newer than the saved session.
  expect(writeRecoveryFile({ messages: turnTwo }, SESSION, 'parser work', { surface })).toBe(true);
  expect(checkRecoveryFile({ surface })?.sessionId).toBe(SESSION);
  expect(checkRecoveryForSession(surface, SESSION)?.sessionId).toBe(SESSION);
  expect(loadRecoveryConversation({ surface }, SESSION)?.messages).toEqual(turnTwo);

  // The turn-end save landed after the snapshot (the crash came before the snapshot was removed).
  persistConversation(SESSION, { messages: turnTwo }, 'model-a', 'provider-a', 'parser work', { surface });
  expect(checkRecoveryFile({ surface })).toBeNull();
  expect(checkRecoveryForSession(surface, SESSION)).toBeNull();
});
