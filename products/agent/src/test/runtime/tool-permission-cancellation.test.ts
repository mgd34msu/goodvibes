import type { HookDispatcher } from '@goodvibes-jev/engine/platform/platform/hooks';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import {
  createPermissionConfigReader, PermissionManager, UserPermissionRuleStore,
  type PermissionAttribution,
} from '@goodvibes-jev/engine/platform/platform/permissions';
import { security } from '@goodvibes-jev/engine/platform/platform/runtime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Permission cancellation did not settle')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}


for (const method of ['check', 'checkDetailed'] as const) {
  test(`${method} preserves real-manager attribution and cancellation during a pending pre-permission hook`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-permission-cancel-'));
    const path = join(root, 'read-target.txt'); writeFileSync(path, 'fixture data');
    const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
    config.set('permissions.mode', 'prompt');
    const entered = deferred(), release = deferred(), returned = deferred();
    const controller = new AbortController(); const options = { signal: controller.signal };
    const attribution: PermissionAttribution = { kind: 'background-agent', agentId: 'agent-cancel-fixture', template: 'reader' };
    const store = new UserPermissionRuleStore(':memory:'); let prompts = 0, fileReads = 0;
    const hooks = { async fire() { entered.resolve(); await release.promise; returned.resolve(); return { ok: true, decision: 'allow' }; } } as unknown as Pick<HookDispatcher, 'fire'>;
    const manager = new PermissionManager(async () => { prompts++; return { approved: true }; },
      createPermissionConfigReader(config), new security.PolicyRuntimeState(), hooks, null, store);
    const original = spyOn(manager, method);
    const pending = manager[method]('read', { files: [{ path }] }, attribution, options).then(decision => {
      if (typeof decision === 'boolean' ? decision : decision.approved) { fileReads++; readFileSync(path, 'utf8'); }
      return decision;
    });
    const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await within(entered.promise);
      expect(original.mock.calls[0]?.[2]).toBe(attribution);
      expect(original.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
      options.signal = new AbortController().signal; controller.abort(new Error('synthetic private cancellation context'));
      const result = await within(outcome);
      expect(result).toMatchObject({ error: { name: 'JudgmentError', kind: 'aborted' } });
      expect(JSON.stringify(result)).not.toContain('synthetic private cancellation context');
      expect(fileReads).toBe(0); expect(prompts).toBe(0);
      release.resolve(); await within(returned.promise); await Bun.sleep(0);
      expect(fileReads).toBe(0); expect(store.list()).toHaveLength(0);
    } finally { release.resolve(); controller.abort(); await within(outcome).catch(() => undefined); original.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
}
