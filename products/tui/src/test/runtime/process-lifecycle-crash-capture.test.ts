/**
 * What the terminal leaves behind when it dies, and what a clean save is
 * judged by on the way out.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import { ShutdownReleaseError } from '../../runtime/bootstrap-shutdown.ts';
import { TERMINAL_ESCAPES } from '@goodvibes-jev/engine/terminal-shell';
import { CRASH_LOG_FILENAME, readCrashRecords } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpHome: string;
let exitSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-crash-capture');
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function harness(shutdown?: () => Promise<void>) {
  const surface = makeTestSurface(tmpHome);
  const sessionId = 'crash-session';
  const stdout: string[] = [];
  const stderr: string[] = [];
  const crashLogPath = join(tmpHome, '.goodvibes', 'tui', CRASH_LOG_FILENAME);
  const ctx = {
    conversation: { toJSON: () => ({ messages: [{ role: 'user', content: 'a question' }] }), getTitleSource: () => 'auto', title: 'Crash test' },
    runtime: { sessionId },
    services: { homeDirectory: tmpHome, surface },
    ...(shutdown ? { shutdown } : {}),
  } as unknown as BootstrapContext;
  const { CLEAR_VIEWPORT_HOME: CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE } = TERMINAL_ESCAPES;
  const handlers = installProcessLifecycle({
    stdin: { setRawMode: () => {}, removeAllListeners: () => {} },
    stdout: { write: (text: string) => { stdout.push(text); return true; }, removeListener: () => {} },
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
    crashLogPath,
    writeStderr: (line: string) => { stderr.push(line); },
  } as unknown as ProcessLifecycleDeps);
  return { handlers, stdout, stderr, crashLogPath, recoveryFile: surface.recoveryFile(sessionId) };
}

describe('an uncaught exception', () => {
  test('leaves a crash record on disk and names the crash and the record on stderr', () => {
    const h = harness();

    h.handlers.uncaughtExceptionHandler(new Error('injected fault'));

    const records = readCrashRecords(h.crashLogPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'uncaughtException', message: 'injected fault', surface: 'tui', sessionId: 'crash-session' });
    expect(h.stderr[0]).toContain('goodvibes crashed: ');
    expect(h.stderr[0]).toContain('injected fault');
    expect(h.stderr[1]).toBe(`crash record written to ${h.crashLogPath}`);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('an unwritable crash log costs neither the stderr line nor the exit', () => {
    const h = harness();
    // A directory where the log file has to be, so the record cannot be written.
    mkdirSync(h.crashLogPath, { recursive: true });

    h.handlers.uncaughtExceptionHandler(new Error('second fault'));

    expect(h.stderr).toHaveLength(1);
    expect(h.stderr[0]).toContain('second fault');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('an unhandled rejection', () => {
  test('is recorded as a crash record while the process stays up', () => {
    const h = harness();

    h.handlers.unhandledRejectionHandler(new Error('rejected somewhere'));

    const records = readCrashRecords(h.crashLogPath);
    expect(records.map((record) => record.kind)).toEqual(['unhandledRejection']);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('a clean save with a failing unrelated release', () => {
  test('is a clean exit: the recovery snapshot goes and no "before save completed" line is printed', async () => {
    const h = harness(async () => { throw new ShutdownReleaseError([new Error('forensics dispose failed')], 'saved, release failed'); });
    h.handlers.enterTerminal();

    await h.handlers.exitApp();

    expect(existsSync(h.recoveryFile)).toBe(false);
    expect(h.stdout.join('')).not.toContain('exit before save completed');
  });

  test('a shutdown that fails for any other reason still keeps the recovery snapshot and says so', async () => {
    const h = harness(async () => { throw new Error('the durable save failed'); });
    h.handlers.enterTerminal();

    await h.handlers.exitApp();

    expect(existsSync(h.recoveryFile)).toBe(true);
    expect(h.stdout.join('')).toContain('exit before save completed: a recovery snapshot was kept for next launch');
  });
});
