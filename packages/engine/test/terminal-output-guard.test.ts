import { describe, expect, test } from 'bun:test';
import {
  allowTerminalWrite,
  installTerminalOutputGuard,
  type TerminalOutputIntercept,
} from '@goodvibes-jev/engine/terminal-shell';
import { allowTerminalWrite as rendererWrite } from '@goodvibes-jev/engine/terminal-shell/terminal-write';

function makeStream() {
  const writes: string[] = [];
  return {
    writes,
    write: (...args: unknown[]) => {
      writes.push(args[0] instanceof Uint8Array ? Buffer.from(args[0]).toString('utf8') : String(args[0] ?? ''));
      const maybeCallback = args[args.length - 1];
      if (typeof maybeCallback === 'function') {
        maybeCallback(null);
      }
      return true;
    },
  };
}

describe('terminal output guard', () => {
  test('captures direct stdout, stderr, and console writes while active', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      stdout.write('raw stdout\n');
      stderr.write('raw stderr\n');
      console.error('console %s', 'error');

      expect(stdout.writes).toEqual([]);
      expect(stderr.writes).toEqual([]);
      expect(captured.map((event) => event.source)).toEqual([
        'stdout',
        'stderr',
        'console.error',
      ]);
      expect(captured[2]?.preview).toBe('console error');
    } finally {
      guard.dispose();
    }
  });

  test('passes only a standalone string or binary BEL while mixed text and cursor controls remain contained', () => {
    const stdout = makeStream(), stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({ stdout, stderr, onIntercept: event => { captured.push(event); } });
    try {
      let acknowledged = 0;
      stdout.write('\x07', () => { acknowledged++; });
      stderr.write(Uint8Array.of(7));
      stdout.write('unexpected text\x07');
      stdout.write('\x07\x1b[2J');
      stderr.write(Uint8Array.of(7, 10));
      expect(stdout.writes).toEqual(['\x07']);
      expect(stderr.writes).toEqual(['\x07']);
      expect(acknowledged).toBe(1);
      expect(captured).toHaveLength(3);
      expect(captured[0]?.text).toBe('unexpected text\x07');
    } finally { guard.dispose(); }
  });

  test('allows compositor-owned writes through allowTerminalWrite', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      expect(rendererWrite).toBe(allowTerminalWrite);
      allowTerminalWrite(() => stdout.write('render diff'));
      rendererWrite(() => stdout.write('next frame'));
      expect(() => rendererWrite(() => { throw new Error('frame stopped'); })).toThrow('frame stopped');
      stdout.write('unowned write');

      expect(stdout.writes).toEqual(['render diff', 'next frame']);
      expect(captured.map(event => event.text)).toEqual(['unowned write']);
    } finally {
      guard.dispose();
    }
    rendererWrite(() => stdout.write('after disposal'));
    expect(stdout.writes.at(-1)).toBe('after disposal');
  });

  test('passes writes through after being deactivated', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      guard.setActive(false);
      stdout.write('normal stdout');
      stderr.write('normal stderr');

      expect(stdout.writes).toEqual(['normal stdout']);
      expect(stderr.writes).toEqual(['normal stderr']);
      expect(captured).toEqual([]);
    } finally {
      guard.dispose();
    }
  });
});
