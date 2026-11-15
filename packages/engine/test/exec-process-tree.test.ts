import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { descendantsOf, killProcessTree } from '../platform/src/platform/tools/exec/process-tree.ts';
import { terminalRequiredNote } from '../platform/src/platform/tools/exec/interactive.ts';

describe('descendantsOf', () => {
  test('collects every depth, children before parents, ignoring unrelated and cyclic rows', () => {
    const table: Array<readonly [number, number]> = [[10, 1], [11, 10], [12, 11], [13, 10], [20, 1], [21, 20], [10, 12]];
    const found = descendantsOf(table, 10);
    expect(new Set(found)).toEqual(new Set([11, 12, 13]));
    expect(found.indexOf(12)).toBeLessThan(found.indexOf(11));
  });
});

describe('killProcessTree', () => {
  test('stops a nohup-ed grandchild, not only the wrapper pid', async () => {
    const proc = Bun.spawn(['/bin/sh', '-c', 'nohup sleep 300 >/dev/null 2>&1 & echo $!; wait'], { stdout: 'pipe', stdin: 'ignore', stderr: 'ignore' });
    const reader = proc.stdout.getReader();
    const grandchild = Number(new TextDecoder().decode((await reader.read()).value).trim());
    expect(Number.isSafeInteger(grandchild)).toBe(true);
    await killProcessTree(proc.pid, 20);
    await proc.exited;
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // A killed child stays a zombie until reaped by init; /proc state tells it apart from a live one.
    const state = (pid: number): string => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')')[1]!.trim()[0]!; } catch { return 'X'; } };
    expect(!alive(grandchild) || state(grandchild) === 'Z').toBe(true);
  });
});

describe('killProcessTree pid reuse', () => {
  test('the final pass skips a pid that is no longer the process that was collected', async () => {
    const tables: Array<Array<readonly [number, number]>> = [[[50, 10], [51, 50], [52, 50]], []];
    const starts = new Map<number, string[]>([[10, ['a', 'a']], [50, ['b', 'b']], [51, ['c', 'c']], [52, ['d', 'reused']]]);
    const sent: Array<[number[], string]> = [];
    await killProcessTree(10, 0, {
      readTable: () => tables.shift() ?? [],
      startTime: (pid) => starts.get(pid)?.shift() ?? null,
      signal: (pids, signal) => { sent.push([[...pids], signal]); },
      sleep: async () => {},
    });
    expect(sent[0]![1]).toBe('SIGTERM');
    expect(new Set(sent[0]![0])).toEqual(new Set([10, 50, 51, 52]));
    expect(sent[1]![1]).toBe('SIGKILL');
    expect(new Set(sent[1]![0])).toEqual(new Set([10, 50, 51]));
  });

  test('a root pid reused by an unrelated program does not get its children killed', async () => {
    // Root 10 exited during the grace and the number now belongs to another program with child 90.
    const tables: Array<Array<readonly [number, number]>> = [[[50, 10]], [[90, 10]]];
    const starts = new Map<number, string[]>([[10, ['a', 'reused']], [50, ['b', 'b']]]);
    const sent: Array<[number[], string]> = [];
    await killProcessTree(10, 0, {
      readTable: () => tables.shift() ?? [],
      startTime: (pid) => starts.get(pid)?.shift() ?? null,
      signal: (pids, signal) => { sent.push([[...pids], signal]); },
      sleep: async () => {},
    });
    expect(sent[1]![1]).toBe('SIGKILL');
    expect(sent[1]![0]).not.toContain(90);
    expect(sent[1]![0]).not.toContain(10);
    expect(sent[1]![0]).toContain(50);
  });

  test('a child spawned during the grace is still killed', async () => {
    const tables: Array<Array<readonly [number, number]>> = [[], [[60, 10]]];
    const sent: Array<[number[], string]> = [];
    await killProcessTree(10, 0, {
      readTable: () => tables.shift() ?? [],
      startTime: () => 'same',
      signal: (pids, signal) => { sent.push([[...pids], signal]); },
      sleep: async () => {},
    });
    expect(new Set(sent[1]![0])).toEqual(new Set([10, 60]));
  });
});

describe('terminalRequiredNote', () => {
  test.each([
    'sudo: no tty present and no askpass program specified',
    'sudo: a terminal is required to read the password; either use the -S option',
    'ssh: Could not open /dev/tty: No such device or address',
    'sudo: a password is required',
  ])('names the terminal need for %s', (stderr) => {
    expect(terminalRequiredNote(stderr)).toContain('interactive: true');
  });
  test('says nothing for an unrelated failure', () => {
    expect(terminalRequiredNote('ls: cannot access x: No such file or directory')).toBeUndefined();
  });
});
