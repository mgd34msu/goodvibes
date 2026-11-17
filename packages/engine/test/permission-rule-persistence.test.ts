/**
 * A remembered permission rule is live only after its file write commits: a
 * save that fails, or one still in flight, never grants anything, and a failed
 * change never drops a rule already saved.
 *
 * Real rule store, real file, real settings and permission manager; the one
 * knob is a write held on a gate the test releases, or failed on purpose.
 * Jev answers from a fixture port.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { ControllableStore, readOnDisk, replaceInternalStore } from './_helpers/controllable-store.ts';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import type { PermissionRequestHandler } from '../platform/src/platform/permissions/prompt.ts';
import { UserPermissionRuleStore, type StoredUserPermissionRule } from '../platform/src/platform/permissions/user-rule-store.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

useGateReadings();

interface RuleFile extends Record<string, unknown> {
  readonly version: 1;
  readonly rules: readonly StoredUserPermissionRule[];
}

const args = (command: string) => ({ commands: [{ cmd: command }] });
const command = 'git commit -m synthetic';

function record(id: string, effect: 'allow' | 'deny' = 'allow'): StoredUserPermissionRule {
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args: args(command), tier: 'exact', effect })!;
  return { rule: { ...rule, id }, createdAt: 1, tier: 'exact', tool: 'exec' };
}

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-permission-persistence-'));
  path = join(dir, 'rules.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function manager(store: UserPermissionRuleStore, handler: PermissionRequestHandler): PermissionManager {
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: join(dir, 'workspace'), homeDir: join(dir, 'home'), configDir: join(dir, 'config') });
  return new PermissionManager(handler, createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, store);
}

/** The rule store over its file, with its writes passed through a store the test can hold or fail. */
async function controlledStore(): Promise<{ store: UserPermissionRuleStore; writes: ControllableStore<RuleFile> }> {
  const writes = new ControllableStore<RuleFile>(path);
  const store = new UserPermissionRuleStore(path);
  replaceInternalStore(store, 'store', writes);
  await store.init();
  return { store, writes };
}

/** Event-loop turns until `done`, bounded in steps. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let step = 0; step < 10_000 && !done(); step += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
  if (!done()) throw new Error(`Gave up waiting for: ${what}`);
}

async function reopened(): Promise<readonly StoredUserPermissionRule[]> {
  const store = new UserPermissionRuleStore(path);
  await store.init();
  return store.list();
}

describe('a remembered rule is live only once saved', () => {
  test('a failed write never becomes a live grant, and a retry is saved and survives reopening', async () => {
    const store = new UserPermissionRuleStore(path);
    await store.init();
    // A directory at the target makes the write fail; the rule file is re-read under the lock before it is replaced.
    mkdirSync(path);
    let asks = 0;
    const permissions = manager(store, async () => { asks++; return { approved: false }; });
    const error = await store.add(record('first')).then(() => null, (cause: unknown) => cause);
    expect((error as Error).message).toContain('EISDIR');
    const decided = await permissions.checkDetailed('exec', args(command));
    expect(decided.sourceLayer).not.toBe('user_rule');
    expect(decided.persisted).not.toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.rules()).toEqual([]);
    rmSync(path, { recursive: true });

    await store.add(record('retry'));
    expect(await permissions.checkDetailed('exec', args(command))).toMatchObject({ approved: true, persisted: true, sourceLayer: 'user_rule' });
    expect(await reopened()).toEqual(store.list());
    expect(store.list().map((entry) => entry.rule.id)).toEqual(['retry']);
    expect(asks).toBe(0);
  });

  test('a grant whose write is still in flight is not visible, and one whose write then fails never is', async () => {
    const { store, writes } = await controlledStore();
    const release = writes.holdNext();
    writes.failNext = true;
    const pending = store.add(record('pending')).then(() => null, (error: unknown) => error);
    await until(() => writes.started === 1, 'the held write to start');
    let asks = 0;
    const permissions = manager(store, async () => { asks++; return { approved: false }; });
    expect((await permissions.checkDetailed('exec', args(command))).sourceLayer).not.toBe('user_rule');
    expect(store.rules()).toEqual([]);
    release();
    expect(await pending).toMatchObject({ message: 'store unavailable' });
    expect((await permissions.checkDetailed('exec', args(command))).sourceLayer).not.toBe('user_rule');
    expect(store.rules()).toEqual([]);
    expect(readOnDisk<RuleFile>(path)).toBeNull();
    expect(asks).toBe(0);
  });

  test('a failed add between two saved ones drops nothing saved and adds nothing unsaved', async () => {
    const { store, writes } = await controlledStore();
    await store.add(record('existing', 'deny'));
    writes.failNext = true;
    const failed = store.add(record('failed')).then(() => null, (error: unknown) => error);
    const succeeding = store.add(record('succeeded'));
    expect(await failed).toMatchObject({ message: 'store unavailable' });
    await succeeding;
    expect(store.rules().map((rule) => rule.id)).toEqual(['existing', 'succeeded']);
    expect(readOnDisk<RuleFile>(path)?.rules).toEqual(store.list());
    expect(await reopened()).toEqual(store.list());
  });

  test('two adds in flight together are both saved, and neither is live before its write commits', async () => {
    const { store, writes } = await controlledStore();
    const release = writes.holdNext();
    const first = store.add(record('first'));
    const second = store.add(record('second'));
    await until(() => writes.started === 1, 'the first write to start');
    expect(store.rules()).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(store.rules().map((rule) => rule.id)).toEqual(['first', 'second']);
    expect(readOnDisk<RuleFile>(path)?.rules).toEqual(store.list());
    expect(await reopened()).toEqual(store.list());
  });

  test.each(['allow', 'deny'] as const)('a failed deletion of a saved %s rule keeps it, and a retry removes it for good', async (effect) => {
    const { store, writes } = await controlledStore();
    const existing = record('existing', effect);
    await store.add(existing);
    writes.failNext = true;
    const failed = store.delete('existing').then(() => null, (error: unknown) => error);
    const adding = store.add(record('later'));
    expect(await failed).toMatchObject({ message: 'store unavailable' });
    await adding;
    expect(store.list()).toEqual([existing, record('later')]);
    expect(readOnDisk<RuleFile>(path)?.rules).toEqual(store.list());
    expect(await store.delete('existing')).toBe(true);
    expect(store.rules().map((rule) => rule.id)).toEqual(['later']);
    expect(await reopened()).toEqual(store.list());
  });
});
