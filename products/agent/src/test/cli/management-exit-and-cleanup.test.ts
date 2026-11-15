import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { closeHeadlessSession, discardUnusedSession } from '../../cli/native-headless-command.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(args: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> {
  const root = makeProjectTempDir('goodvibes-agent-management-exit');
  roots.push(root);
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' }),
      workingDirectory: root,
      homeDirectory: root,
    });
    return { exitCode: result.exitCode, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('refusals exit non-zero', () => {
  test('pair without an operator token is a refusal', async () => {
    const result = await run(['pair']);
    expect(result.output).toContain('Connected-host operator token is required.');
    expect(result.exitCode).toBe(1);
  });

  test('a blocked task submission is a usage-class refusal', async () => {
    const result = await run(['tasks', 'submit', 'do', 'something']);
    expect(result.output).toContain('blocks CLI task submission');
    expect(result.exitCode).toBe(2);
  });
});

describe('a run that could not start', () => {
  test('takes back the empty session its teardown saved', () => {
    const deleted: string[] = [];
    const manager = { delete(name: string) { deleted.push(name); } };
    expect(discardUnusedSession(manager, 'fresh-id', false, 0)).toBe(true);
    expect(deleted).toEqual(['fresh-id']);
  });

  test('keeps a session that ran or that has messages', () => {
    const deleted: string[] = [];
    const manager = { delete(name: string) { deleted.push(name); } };
    expect(discardUnusedSession(manager, 'ran', true, 0)).toBe(false);
    expect(discardUnusedSession(manager, 'has-messages', false, 2)).toBe(false);
    expect(deleted).toEqual([]);
  });

  test('a run that never got a session discards the empty one after shutdown and writes no pointer', async () => {
    const events: string[] = [];
    await closeHeadlessSession({
      shutdown: async () => { events.push('shutdown'); },
      sessionManager: { delete(name: string) { events.push(`delete ${name}`); } },
      sessionId: 'fresh-id',
      sessionReady: false,
      messageCount: 0,
      writeSessionPointer: () => { events.push('pointer'); },
    });
    expect(events).toEqual(['shutdown', 'delete fresh-id']);
  });

  test('a run with a session writes the pointer and keeps the session', async () => {
    const events: string[] = [];
    await closeHeadlessSession({
      shutdown: async () => { events.push('shutdown'); },
      sessionManager: { delete(name: string) { events.push(`delete ${name}`); } },
      sessionId: 'ran',
      sessionReady: true,
      messageCount: 2,
      writeSessionPointer: () => { events.push('pointer'); },
    });
    expect(events).toEqual(['shutdown', 'pointer']);
  });

  test('a delete that finds nothing is not an error', () => {
    const manager = { delete() { throw new Error('Session not found'); } };
    expect(discardUnusedSession(manager, 'gone', false, 0)).toBe(false);
  });
});
