/**
 * Starting an external process keeps the workspace bounds that admitted it:
 * the process must run where its trust owner says, and the returned check
 * fails once the trust decision or the signal has changed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { prepareExternalExecution } from '../platform/src/platform/permissions/external-execution.ts';
import type { ExternalPermissionHost } from '../platform/src/platform/permissions/external-request.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workspace(): { root: string; other: string } {
  const base = mkdtempSync(join(tmpdir(), 'gv-external-exec-'));
  dirs.push(base);
  const root = join(base, 'root'), other = join(base, 'other');
  mkdirSync(root); mkdirSync(other);
  return { root, other };
}
function host(overrides: Partial<ExternalPermissionHost>): ExternalPermissionHost {
  return {
    port: {} as JudgmentPort,
    permissionManager: { admitAutonomous: async () => { throw new Error('unused'); } },
    config: { onDidInvalidate: () => () => undefined },
    signal: new AbortController().signal,
    ...overrides,
  };
}
const trust = () => ({ async prepareAutonomousConstraint() { return () => undefined; } });

describe('prepareExternalExecution', () => {
  test('a host with no workspace trust owner cannot start a process', async () => {
    const { root } = workspace();
    await expect(prepareExternalExecution(host({}), root, new AbortController().signal)).rejects.toThrow('no workspace trust owner');
  });

  test('a process must run in the workspace its trust owner covers', async () => {
    const { root, other } = workspace();
    const owner = host({ workspaceTrust: trust(), workspaceRoot: root });
    await expect(prepareExternalExecution(owner, other, new AbortController().signal)).rejects.toThrow('differs from its workspace trust owner');
    await expect(prepareExternalExecution(owner, root, new AbortController().signal)).resolves.toBeInstanceOf(Function);
  });

  test('the returned check fails once the call or host signal aborts', async () => {
    const { root } = workspace();
    const callAbort = new AbortController();
    const hostAbort = new AbortController();
    const state = host({ workspaceTrust: trust(), workspaceRoot: root, signal: hostAbort.signal });
    const byCall = await prepareExternalExecution(state, root, callAbort.signal);
    const byHost = await prepareExternalExecution(state, root, new AbortController().signal);
    callAbort.abort();
    expect(() => byCall()).toThrow();
    expect(() => byHost()).not.toThrow();
    hostAbort.abort();
    expect(() => byHost()).toThrow();
  });

  test('an explicit null owner declares no separate workspace policy and is allowed anywhere', async () => {
    const { other } = workspace();
    await expect(prepareExternalExecution(host({ workspaceTrust: null }), other, new AbortController().signal)).resolves.toBeInstanceOf(Function);
  });
});
