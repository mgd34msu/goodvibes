import { describe, expect, test } from 'bun:test';
import { createScriptableStatusline, sanitizeStatuslineOutput, type StatuslineCommandRunner } from '@/core/scriptable-statusline.ts';
import type { StatuslineSettings } from '@/config/tui-extension-settings.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

// Every case injects readSettings, so the manager is never read.
const emptyConfig = {} as Pick<ConfigManager, 'get'>;

/** A minimal turn-event emitter matching the subscription surface the statusline needs. */
function makeTurns() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(event: string, handler: () => void): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event: string): void {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

const settingsOf = (settings: StatuslineSettings) => () => settings;

describe('sanitizeStatuslineOutput', () => {
  test('keeps only the first line', () => {
    expect(sanitizeStatuslineOutput('one\ntwo\nthree')).toBe('one');
  });

  test('strips ANSI escape sequences', () => {
    expect(sanitizeStatuslineOutput('\x1b[31mred\x1b[0m status')).toBe('red status');
  });

  test('strips control characters', () => {
    expect(sanitizeStatuslineOutput('a\x07b\x00c')).toBe('abc');
  });

  test('converts tabs to spaces and trims', () => {
    expect(sanitizeStatuslineOutput('  a\tb  ')).toBe('a b');
  });

  test('returns null for empty/whitespace output', () => {
    expect(sanitizeStatuslineOutput('')).toBeNull();
    expect(sanitizeStatuslineOutput('   \n')).toBeNull();
  });

  test('caps very long output', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeStatuslineOutput(long)?.length).toBe(512);
  });
});

describe('createScriptableStatusline', () => {
  test('is null when no command is configured', async () => {
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns: makeTurns(),
      readSettings: settingsOf({}),
    });
    await statusline.settled();
    expect(statusline.current()).toBeNull();
  });

  test('renders the sanitized command output after priming', async () => {
    const runner: StatuslineCommandRunner = async () => 'branch main | clean\n';
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns: makeTurns(),
      runner,
      readSettings: settingsOf({ command: 'echo hi' }),
    });
    await statusline.settled();
    expect(statusline.current()).toBe('branch main | clean');
  });

  test('refreshes on TURN_COMPLETED', async () => {
    let calls = 0;
    const runner: StatuslineCommandRunner = async () => `run ${++calls}`;
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    await statusline.settled();
    expect(statusline.current()).toBe('run 1');
    turns.emit('TURN_COMPLETED');
    await statusline.settled();
    expect(statusline.current()).toBe('run 2');
  });

  test('clears the value when the command fails', async () => {
    let ok = true;
    const runner: StatuslineCommandRunner = async () => {
      if (ok) return 'good';
      throw new Error('boom');
    };
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    await statusline.settled();
    expect(statusline.current()).toBe('good');
    ok = false;
    turns.emit('TURN_ERROR');
    await statusline.settled();
    expect(statusline.current()).toBeNull();
  });

  test('coalesces overlapping refreshes into a single trailing run', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let total = 0;
    const releases: Array<() => void> = [];
    let trailingStarted!: () => void;
    const trailingRun = new Promise<void>((resolve) => { trailingStarted = resolve; });
    const runner: StatuslineCommandRunner = async () => {
      running += 1;
      total += 1;
      const mine = total;
      if (mine === 2) trailingStarted();
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      running -= 1;
      return `n${mine}`;
    };
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    // The priming run is in flight and held; fire several boundary refreshes on top of it.
    turns.emit('TURN_COMPLETED');
    turns.emit('TURN_COMPLETED');
    turns.emit('TURN_COMPLETED');
    expect(total).toBe(1);
    releases[0]!(); // the priming run finishes; exactly one trailing run starts
    await trailingRun;
    expect(total).toBe(2);
    releases[1]!();
    await statusline.settled();
    expect(maxConcurrent).toBe(1); // never overlapped
    expect(total).toBe(2); // priming + one coalesced trailing run
    expect(statusline.current()).toBe('n2');
  });
});
