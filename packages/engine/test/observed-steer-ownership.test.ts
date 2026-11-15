/**
 * Observed sessions are foreign ones: anything this runtime spawned or hosts is
 * excluded, and a steer is only typed into a pane that still hosts the session
 * the row described.
 */
import { describe, expect, test } from 'bun:test';
import { classifyObservedProcesses, type ObservedRawProcess, type ProcessTableReader, type TmuxPaneReader } from '../platform/src/platform/runtime/fleet/observed/detect.ts';
import { ObservedAgentSource, type ObservedAgentRow, type TmuxCommandRunner } from '../platform/src/platform/runtime/fleet/observed/source.ts';

const proc = (pid: number, ppid: number, args: string, tty?: string): ObservedRawProcess => ({ pid, ppid, args, tty, cpuSeconds: 0 });

describe('classifyObservedProcesses ownership', () => {
  test('a hosted agent below the runtime pid is not observed, a sibling is', () => {
    const table = [
      proc(100, 1, 'bun daemon'),
      proc(110, 100, 'sh -c codex acp'),
      proc(111, 110, 'codex acp'),
      proc(200, 1, 'codex --foo', '/dev/pts/3'),
    ];
    expect(classifyObservedProcesses(table, new Set([100])).map((row) => row.pid)).toEqual([200]);
    expect(classifyObservedProcesses(table).map((row) => row.pid).sort()).toEqual([111, 200]);
  });

  test('a parent cycle in the table does not hang the walk', () => {
    const table = [proc(5, 6, 'codex a'), proc(6, 5, 'sh')];
    expect(classifyObservedProcesses(table, new Set([99])).map((row) => row.pid)).toEqual([5]);
  });
});

describe('ObservedAgentSource steer re-verification', () => {
  const row: ObservedAgentRow = {
    externalKind: 'codex', pid: 200, ppid: 1, args: 'codex --foo', startedAt: 5000,
    liveness: { state: 'quiet', cpuSeconds: 0, detail: 'x' },
    steer: { kind: 'tmux', paneId: '%1', tty: '/dev/pts/3' },
  };
  function setup(table: () => readonly ObservedRawProcess[], panes: () => ReturnType<TmuxPaneReader['listPanes']>) {
    const calls: string[][] = [];
    const steerRunner: TmuxCommandRunner = { run: (args) => { calls.push([...args]); return { status: 0, stderr: '' }; } };
    const processReader: ProcessTableReader = { read: table };
    const source = new ObservedAgentSource({ processReader, paneReader: { listPanes: panes }, steerRunner, ownPid: 9999, now: () => 0 });
    return { source, calls };
  }
  const live = (): readonly ObservedRawProcess[] => [{ ...proc(200, 1, 'codex --foo', '/dev/pts/3'), startedAt: 5000 }];

  test('sends when the same session is still on the same pane', () => {
    const { source, calls } = setup(live, () => [{ paneId: '%1', tty: '/dev/pts/3' }]);
    expect(source.steer(row, 'hi').queued).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test('refuses and sends nothing when the process has exited', () => {
    const { source, calls } = setup(() => [], () => [{ paneId: '%1', tty: '/dev/pts/3' }]);
    const result = source.steer(row, 'rm -rf x');
    expect(result.queued).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('refuses when the pid was reused by a process started later', () => {
    const { source, calls } = setup(() => [{ ...live()[0]!, startedAt: 9000 }], () => [{ paneId: '%1', tty: '/dev/pts/3' }]);
    expect(source.steer(row, 'hi').queued).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('refuses when the terminal no longer maps to the pane', () => {
    const { source, calls } = setup(live, () => [{ paneId: '%2', tty: '/dev/pts/3' }]);
    const result = source.steer(row, 'hi');
    expect(result.queued).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
