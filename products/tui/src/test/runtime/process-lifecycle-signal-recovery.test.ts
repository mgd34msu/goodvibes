/**
 * A terminal close (SIGHUP), SIGTERM or a crash never reaches the graceful
 * session save, so each must leave a recovery snapshot of the conversation as
 * it stood, synchronously, before the process exits.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import { startRecoveryAutosave } from '../../runtime/recovery-autosave.ts';
import { TERMINAL_ESCAPES } from '@goodvibes-jev/engine/terminal-shell';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import type { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpHome: string;
let exitSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-signal-recovery');
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function harness() {
  const surface = makeTestSurface(tmpHome);
  const sessionId = 'signal-recovery-session';
  const ctx = {
    conversation: {
      toJSON: () => ({ messages: [{ role: 'user', content: 'unsaved question' }] }),
      getTitleSource: () => 'auto',
      title: 'Signal test',
    },
    runtime: { sessionId },
    services: { homeDirectory: tmpHome, surface },
  } as unknown as BootstrapContext;
  const { CLEAR_VIEWPORT_HOME: CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE } = TERMINAL_ESCAPES;
  const handlers = installProcessLifecycle({
    stdin: { setRawMode: () => {} },
    stdout: { write: () => true },
    ctx,
    noAltScreen: false,
    ansi: { CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE },
    getInput: () => ({ hostPairing: undefined }),
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => {} }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({}),
    unsubs: [],
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
  } as unknown as ProcessLifecycleDeps);
  return { handlers, recoveryFile: surface.recoveryFile(sessionId) };
}

test('SIGHUP writes the recovery snapshot before exiting with 129', () => {
  const { handlers, recoveryFile } = harness();
  handlers.terminationSignalHandler('SIGHUP');
  expect(existsSync(recoveryFile)).toBe(true);
  expect(readFileSync(recoveryFile, 'utf8')).toContain('unsaved question');
  expect(exitSpy).toHaveBeenCalledWith(129);
});

test('an uncaught exception writes the recovery snapshot before exiting with 1', () => {
  const { handlers, recoveryFile } = harness();
  handlers.uncaughtExceptionHandler(new Error('boom'));
  expect(existsSync(recoveryFile)).toBe(true);
  expect(exitSpy).toHaveBeenCalledWith(1);
});

test('an autosave tick that throws is contained instead of crashing the process', async () => {
  let calls = 0;
  let revision = 0;
  // Three failed ticks in a row: a first tick that escaped as an uncaught
  // exception would have been reported before the third one runs.
  const thirdTick = Promise.withResolvers<void>();
  const conversation = {
    toJSON: () => { calls += 1; if (calls === 3) thirdTick.resolve(); throw new Error('snapshot failed'); },
    getTitleSource: () => 'auto',
    title: '',
    // A revision that moves on every read, so every tick has a change to write.
    revisionSource: { revision: () => (revision += 1) },
  } as unknown as ConversationManager;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  const timer = startRecoveryAutosave({ conversation, runtime: { sessionId: 'tick' }, surface: makeTestSurface(tmpHome), buildSessionContinuityHints: () => ({ pendingApprovals: 0 }), intervalMs: 5 });
  try {
    await thirdTick.promise;
  } finally {
    clearInterval(timer);
    process.removeListener('uncaughtException', onUncaught);
  }
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(uncaught).toEqual([]);
});
