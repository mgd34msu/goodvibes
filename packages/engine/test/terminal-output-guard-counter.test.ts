import { describe, expect, test } from 'bun:test';
import { installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell';

// direct terminal writes that would corrupt a full-screen renderer are
// captured and counted (surfaced by e.g. /debug), NOT pushed as repeated
// transcript lines.
describe('terminal-output guard cumulative counter (onCapture)', () => {
  test('captured writes increment a cumulative counter and are suppressed from the stream', () => {
    const written: string[] = [];
    const fakeStdout = { write: (s: string | Uint8Array) => { written.push(String(s)); return true; } };
    const captures: number[] = [];

    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      stderr: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
    });
    try {
      // After install, fakeStdout.write is the guard wrapper: a direct write is
      // intercepted (never reaches the real stream) and bumps the counter.
      (fakeStdout.write as (s: string) => boolean)('rogue direct stdout line\n');
      expect(captures).toEqual([1]);       // counter surfaced via onCapture
      expect(written).toEqual([]);         // suppressed, not written through
    } finally {
      guard.dispose();
    }
  });

  test('every capture in a burst reports the running total, even inside the notice rate-limit window', () => {
    const fakeStdout = { write: () => true };
    const captures: number[] = [];
    const notices: string[] = [];

    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
      notify: (notice) => { notices.push(notice); },
    });
    try {
      (fakeStdout.write as (s: string) => boolean)('first\n');
      (fakeStdout.write as (s: string) => boolean)('second, same instant\n');
      (fakeStdout.write as (s: string) => boolean)('third, same instant\n');
      expect(captures).toEqual([1, 2, 3]);
      // Only the transcript notice is rate-limited.
      expect(notices).toHaveLength(1);
    } finally {
      guard.dispose();
    }
  });
});
