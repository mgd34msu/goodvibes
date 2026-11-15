/**
 * Hook dispatch, chains, triggers, the managed hooks file and the runners:
 * what a configured hook, chain or trigger actually does when an event fires.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, HookWorkbench, createHookApi, createHookApiDispatcher, safeEvaluate } from '@goodvibes-jev/engine/platform/platform/hooks';
import type { HookEvent, HookDefinition } from '@goodvibes-jev/engine/platform/platform/hooks';
import { hookTimeoutSeconds } from '../platform/src/platform/hooks/execution.ts';
import { AutomationCommands } from '../platform/src/platform/workflow/automation-commands.ts';
import { run as runHttp } from '../platform/src/platform/hooks/runners/http.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-hooks-behaviour-'));
  dirs.push(dir);
  return dir;
}

function makeEvent(path: string, payload: Record<string, unknown> = {}): HookEvent {
  const [phase, category, ...rest] = path.split(':');
  return { path, phase, category, specific: rest.join(':'), sessionId: 's', timestamp: 0, payload } as unknown as HookEvent;
}

describe('chains', () => {
  test('a completed chain runs its action once, and the action does not feed the chain again', async () => {
    const dir = tempDir();
    const marker = join(dir, 'marker');
    const dispatcher = new HookDispatcher();
    dispatcher.registerChain({
      name: 'edit-then-test',
      steps: [{ match: 'Post:tool:edit' }, { match: 'Post:tool:test' }],
      // The action's own match is the last step's path: firing it as an event would loop.
      action: { match: 'Post:tool:test', type: 'command', command: `echo ran >> ${marker}` },
    });
    await dispatcher.fire(makeEvent('Post:tool:edit'));
    expect(existsSync(marker)).toBe(false);
    await dispatcher.fire(makeEvent('Post:tool:test'));
    expect(readFileSync(marker, 'utf-8')).toBe('ran\n');
  });

  test('a chain registered under a name already in use is refused', () => {
    const dispatcher = new HookDispatcher();
    const chain = { name: 'c', steps: [{ match: 'Pre:tool:*' }], action: { match: 'Post:tool:x', type: 'command' as const, command: 'true' } };
    expect(dispatcher.registerChain(chain)).toBe(true);
    expect(dispatcher.registerChain({ ...chain })).toBe(false);
    expect(dispatcher.getChains()).toHaveLength(1);
  });

  test('an optional step is skipped when the next step\'s event arrives first', async () => {
    const dir = tempDir();
    const marker = join(dir, 'marker');
    const dispatcher = new HookDispatcher();
    dispatcher.registerChain({
      name: 'skip-optional',
      steps: [{ match: 'Post:tool:edit' }, { match: 'Post:tool:lint', optional: true }, { match: 'Post:tool:test' }],
      action: { match: 'Post:tool:done', type: 'command', command: `echo ran >> ${marker}` },
    });
    await dispatcher.fire(makeEvent('Post:tool:edit'));
    await dispatcher.fire(makeEvent('Post:tool:test'));
    expect(existsSync(marker)).toBe(true);
  });

  test('a deny from a chain action reaches the event that completed the chain', async () => {
    const dispatcher = new HookDispatcher();
    dispatcher.registerChain({
      name: 'guard',
      steps: [{ match: 'Pre:tool:write' }],
      action: { match: 'Pre:tool:write', type: 'command', command: `echo '{"decision":"deny","reason":"no"}'` },
    });
    const result = await dispatcher.fire(makeEvent('Pre:tool:write'));
    expect(result.decision).toBe('deny');
  });
});

describe('triggers', () => {
  test('a trigger is evaluated for an event no hook matches', async () => {
    const dispatcher = new HookDispatcher();
    let listed = 0;
    dispatcher.setTriggerManager({ list: () => { listed++; return []; }, commands: new AutomationCommands() });
    const result = await dispatcher.fire(makeEvent('Post:tool:read'));
    expect(result.ok).toBe(true);
    expect(listed).toBe(1);
  });
});

describe('once hooks', () => {
  test('two overlapping fires run a once hook one time', async () => {
    const dir = tempDir();
    const marker = join(dir, 'marker');
    const dispatcher = new HookDispatcher();
    dispatcher.register('Pre:tool:x', { match: 'Pre:tool:x', type: 'command', once: true, command: `sleep 0.2; echo ran >> ${marker}` });
    await Promise.all([dispatcher.fire(makeEvent('Pre:tool:x')), dispatcher.fire(makeEvent('Pre:tool:x'))]);
    expect(readFileSync(marker, 'utf-8')).toBe('ran\n');
    expect(dispatcher.listHooks()).toHaveLength(0);
  });
});

describe('ts hooks', () => {
  async function fireTs(body: string): Promise<Awaited<ReturnType<HookDispatcher['fire']>>> {
    const dir = tempDir();
    writeFileSync(join(dir, 'hook.ts'), body);
    const dispatcher = new HookDispatcher({ projectRoot: dir });
    dispatcher.register('Pre:tool:*', { match: 'Pre:tool:*', type: 'ts', path: 'hook.ts' });
    dispatcher.register('Pre:tool:*', { match: 'Pre:tool:*', type: 'ts', path: 'hook.ts', name: 'second' });
    return dispatcher.fire(makeEvent('Pre:tool:read'));
  }

  test('a handler that returns nothing is a success, not a rejected fire', async () => {
    expect(await fireTs('export default async () => {};\n')).toMatchObject({ ok: true });
  });

  test('a bare decision keeps the result ok', async () => {
    expect(await fireTs("export default async () => ({ decision: 'deny', reason: 'blocked' });\n")).toMatchObject({ ok: true, decision: 'deny', reason: 'blocked' });
  });
});

describe('safeEvaluate', () => {
  test('a single = or other unsupported character makes the condition false, not truthy', () => {
    expect(safeEvaluate("status == 'a'", { status: 'b' })).toBe(false);
    expect(safeEvaluate('a & b', { a: true, b: true })).toBe(false);
    expect(safeEvaluate('a === b === c', { a: 1, b: 1, c: 1 })).toBe(false);
  });
  test('a well-formed condition still evaluates', () => {
    expect(safeEvaluate("status === 'a'", { status: 'a' })).toBe(true);
  });
});

describe('command hook deadline', () => {
  test('a hook that leaves a child holding its output is stopped at its deadline', async () => {
    const dispatcher = new HookDispatcher();
    dispatcher.register('Pre:tool:x', { match: 'Pre:tool:x', type: 'command', command: 'sleep 30 & wait', timeout: 0.3 });
    const result = await dispatcher.fire(makeEvent('Pre:tool:x'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });
});

describe('hooks file trust', () => {
  test('a hooks file any user can write is not loaded', () => {
    const dir = tempDir();
    const file = join(dir, 'hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: { 'Pre:tool:*': [{ match: 'Pre:tool:*', type: 'command', command: 'true' }] } }));
    chmodSync(file, 0o666);
    const dispatcher = new HookDispatcher();
    dispatcher.loadFromFile(file);
    expect(dispatcher.listHooks()).toHaveLength(0);
    chmodSync(file, 0o644);
    dispatcher.loadFromFile(file);
    expect(dispatcher.listHooks()).toHaveLength(1);
  });
});

function workbenchFor(dispatcher: HookDispatcher, file: string): HookWorkbench {
  return new HookWorkbench(dispatcher, () => file);
}
function apiFor(dispatcher: HookDispatcher, workbench: HookWorkbench, save?: (path?: string) => Promise<void>) {
  return createHookApi({
    dispatcher: createHookApiDispatcher(dispatcher),
    workbench: save
      ? new Proxy(workbench, { get: (target, key) => (key === 'saveManagedConfig' ? save : Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key)) })
      : workbench,
    listContracts: () => [],
  });
}

describe('managed hooks file', () => {
  test('an unreadable hooks file is not overwritten by a scaffold', async () => {
    const dir = tempDir();
    const file = join(dir, 'hooks.json');
    const original = '{ "hooks": { oops';
    writeFileSync(file, original);
    const dispatcher = new HookDispatcher();
    const api = apiFor(dispatcher, workbenchFor(dispatcher, file));
    await expect(api.workbench.scaffoldHook('g', 'Pre:tool:*', 'command')).rejects.toThrow('not changed');
    expect(readFileSync(file, 'utf-8')).toBe(original);
    await expect(api.workbench.reload()).rejects.toThrow('left unchanged');
  });

  test('a hook added at runtime survives a reload', async () => {
    const dir = tempDir();
    const file = join(dir, 'hooks.json');
    const dispatcher = new HookDispatcher();
    dispatcher.register('Pre:tool:*', { match: 'Pre:tool:*', type: 'command', command: 'true', name: 'runtime' });
    const api = apiFor(dispatcher, workbenchFor(dispatcher, file));
    await api.workbench.scaffoldHook('from-file', 'Pre:tool:*', 'command');
    await api.workbench.reload();
    expect(dispatcher.listHooks().map(({ hook }) => hook.name).sort()).toEqual(['from-file', 'runtime']);
  });

  test('two overlapping verbs both take effect', async () => {
    const dir = tempDir();
    const file = join(dir, 'hooks.json');
    const dispatcher = new HookDispatcher();
    const workbench = workbenchFor(dispatcher, file);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const api = apiFor(dispatcher, workbench, async (path) => {
      if (first) { first = false; await gate; }
      return HookWorkbench.prototype.saveManagedConfig.call(workbench, path);
    });
    const a = api.workbench.scaffoldHook('a', 'Pre:tool:*', 'command');
    const b = api.workbench.scaffoldHook('b', 'Post:tool:*', 'command');
    release();
    await Promise.all([a, b]);
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as { hooks: Record<string, HookDefinition[]> };
    expect(Object.keys(saved.hooks).sort()).toEqual(['Post:tool:*', 'Pre:tool:*']);
  });

  test('an import reports what it dropped and does not duplicate an unnamed hook', async () => {
    const dir = tempDir();
    const file = join(dir, 'hooks.json');
    const incoming = join(dir, 'incoming.json');
    writeFileSync(incoming, JSON.stringify({ hooks: { 'Pre:tool:*': [{ match: 'Pre:tool:*', type: 'command', command: 'true' }, { match: 'Pre:tool:*', type: 'bogus' }] } }));
    const dispatcher = new HookDispatcher();
    const workbench = workbenchFor(dispatcher, file);
    workbench.loadManagedConfig();
    workbench.importManagedConfig(incoming);
    expect(workbench.getLastImportRejections()).toHaveLength(1);
    workbench.importManagedConfig(incoming);
    expect(workbench.listManagedHooks()).toHaveLength(1);
  });
});

describe('hook API wiring', () => {
  test('the dispatcher view lists a chain registered at runtime, not only managed ones', () => {
    const dispatcher = new HookDispatcher();
    const workbench = workbenchFor(dispatcher, join(tempDir(), 'hooks.json'));
    dispatcher.registerChain({ name: 'live', steps: [{ match: 'Pre:tool:*' }], action: { match: 'Post:tool:x', type: 'command', command: 'true' } });
    const api = apiFor(dispatcher, workbench);
    expect(api.dispatcher.listChains().map((chain) => chain.name)).toEqual(['live']);
    expect(api.workbench.listManagedChains()).toHaveLength(0);
  });

  test('an import through the API resolves with what it dropped', async () => {
    const dir = tempDir();
    const incoming = join(dir, 'incoming.json');
    writeFileSync(incoming, JSON.stringify({ hooks: { 'Pre:tool:*': [{ match: 'Pre:tool:*', type: 'command', command: 'true' }, { match: 'Pre:tool:*', type: 'bogus' }] } }));
    const dispatcher = new HookDispatcher();
    const api = apiFor(dispatcher, workbenchFor(dispatcher, join(dir, 'hooks.json')));
    const rejected = await api.workbench.import(incoming);
    expect(rejected).toHaveLength(1);
    expect(api.workbench.listManagedHooks()).toHaveLength(1);
    expect(await api.workbench.import(incoming)).toHaveLength(1);
  });
});

describe('hook deadlines', () => {
  test('a hook without its own timeout gets the documented default; 0 means none', () => {
    expect(hookTimeoutSeconds({}, 'command')).toBe(30);
    expect(hookTimeoutSeconds({}, 'http')).toBe(30);
    expect(hookTimeoutSeconds({}, 'agent')).toBe(60);
    expect(hookTimeoutSeconds({ timeout: 0 }, 'command')).toBe(0);
    expect(hookTimeoutSeconds({ timeout: 5 }, 'agent')).toBe(5);
  });
});

describe('http hook redirects', () => {
  test('a redirect is reported and not followed', async () => {
    let followed = false;
    const target = Bun.serve({ port: 0, fetch() { followed = true; return new Response('{}'); } });
    const origin = Bun.serve({ port: 0, fetch() { return Response.redirect(`http://127.0.0.1:${target.port}/`, 302); } });
    try {
      const result = await runHttp({ match: '*', type: 'http', url: `http://127.0.0.1:${origin.port}/`, allowInternal: true, timeout: 5 }, makeEvent('Pre:tool:x'));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('redirect');
      expect(followed).toBe(false);
    } finally {
      origin.stop(true);
      target.stop(true);
    }
  });
});
