/**
 * The hosted contract adapter and the sessions it creates: a session made for
 * a dispatch ends with the work, never outlives a failed start, and a retried
 * dispatch does not start the work twice.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createHostedContractWorkAdapter } from '../../platform/src/platform/hosted-sessions/contract-work-adapter.ts';
import type { HostedSessionRecord } from '../../platform/src/platform/hosted-sessions/types.ts';

type Status = 'running' | 'passed' | 'cancelled';

function setup(options?: { readonly startFails?: boolean; readonly allowedWorkspaceRoots?: readonly string[]; readonly ownsSession?: (sessionId: string) => boolean }) {
  const killed: string[] = [];
  const created: string[] = [];
  const contracts = new Map<string, { id: string; status: Status; sessionId: string; ownerAgentId: string; createdAt: number; escalations: never[]; decisions: never[] }>();
  let started = 0;
  const adapter = createHostedContractWorkAdapter({
    runner: {
      start: async ({ sessionId }: { sessionId?: string | undefined }) => {
        if (options?.startFails) throw new Error('the floor could not start the contract');
        started += 1;
        const contract = { id: `ctr-${started}`, status: 'running' as Status, sessionId: sessionId ?? '', ownerAgentId: 'agent', createdAt: 0, escalations: [], decisions: [] };
        contracts.set(contract.id, contract);
        return { contract };
      },
      get: (id: string) => contracts.get(id) ?? null,
      cancel: (id: string) => { const contract = contracts.get(id); if (contract) contract.status = 'cancelled'; },
    } as never,
    hostedSessions: {
      hosts: () => true,
      create: async () => { const id = `hosted-${created.length + 1}`; created.push(id); return { id } as HostedSessionRecord; },
      kill: async (id: string) => { killed.push(id); return {} as HostedSessionRecord; },
    },
    workspaceRoot: '/work/default',
    ...(options?.ownsSession === undefined ? {} : { ownsSession: options.ownsSession }),
    ...(options?.allowedWorkspaceRoots === undefined ? {} : { allowedWorkspaceRoots: options.allowedWorkspaceRoots }),
  });
  return { adapter, killed, created, contracts, started: () => started };
}

describe('sessions created for a dispatch', () => {
  test('a dispatch whose contract cannot start does not leave its session behind', async () => {
    const h = setup({ startFails: true });
    await expect(h.adapter.dispatch({ task: 'Do it.' })).rejects.toThrow('could not start');
    expect(h.killed).toEqual(h.created);
  });

  test('the session ends when the requester reads a settled result, not before', async () => {
    const h = setup();
    const handle = await h.adapter.dispatch({ task: 'Do it.' });
    await h.adapter.status(handle.externalTaskId);
    expect(h.killed).toEqual([]);
    h.contracts.get(handle.externalTaskId)!.status = 'passed';
    await h.adapter.result(handle.externalTaskId);
    expect(h.killed).toEqual(['hosted-1']);
  });

  test('cancelling the work ends its session', async () => {
    const h = setup();
    const handle = await h.adapter.dispatch({ task: 'Do it.' });
    await h.adapter.cancel(handle.externalTaskId);
    expect(h.killed).toEqual(['hosted-1']);
  });

  test('a session the requester named is never ended by the adapter', async () => {
    const h = setup({ ownsSession: () => true });
    const handle = await h.adapter.dispatch({ task: 'Do it.', metadata: { sessionId: 'theirs' } });
    h.contracts.get(handle.externalTaskId)!.status = 'passed';
    await h.adapter.result(handle.externalTaskId);
    expect(h.killed).toEqual([]);
  });
});

describe('dispatch requests', () => {
  test('a retry with the same idempotency key returns the first contract', async () => {
    const h = setup();
    const first = await h.adapter.dispatch({ task: 'Do it.', metadata: { idempotencyKey: 'k1' } });
    const retry = await h.adapter.dispatch({ task: 'Do it.', metadata: { idempotencyKey: 'k1' } });
    expect(retry.externalTaskId).toBe(first.externalTaskId);
    expect(h.started()).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  test('a workspace outside the allowed roots is refused when roots are configured', async () => {
    const h = setup({ allowedWorkspaceRoots: ['/work/projects'] });
    await expect(h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/' } })).rejects.toThrow('outside the workspaces');
    await expect(h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/work/projects/../secrets' } })).rejects.toThrow('outside the workspaces');
    await h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/work/projects/app' } });
    expect(h.created).toHaveLength(1);
  });
});

describe('what a requester may reach', () => {
  test('naming a hosted session is refused unless the requester owns it', async () => {
    const refused = setup();
    await expect(refused.adapter.dispatch({ task: 'x', metadata: { sessionId: 'someone-elses' } })).rejects.toThrow('may not run work on hosted session');
    expect(refused.started()).toBe(0);
    const scoped = setup({ ownsSession: (id) => id === 'mine' });
    await expect(scoped.adapter.dispatch({ task: 'x', metadata: { sessionId: 'someone-elses' } })).rejects.toThrow('may not run work');
    await scoped.adapter.dispatch({ task: 'x', metadata: { sessionId: 'mine' } });
    expect(scoped.started()).toBe(1);
  });

  test('with no allowed roots configured only the default workspace is reachable', async () => {
    const h = setup();
    await expect(h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/' } })).rejects.toThrow('outside the workspaces');
    await expect(h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/etc' } })).rejects.toThrow('outside the workspaces');
    await h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: '/work/default/sub' } });
    expect(h.created).toHaveLength(1);
  });

  test('a symlink inside an allowed root does not lead out of it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gv-adapter-roots-'));
    try {
      const allowed = join(base, 'allowed');
      const outside = join(base, 'outside');
      mkdirSync(allowed);
      mkdirSync(outside);
      symlinkSync(outside, join(allowed, 'escape'));
      const h = setup({ allowedWorkspaceRoots: [allowed] });
      await expect(h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: join(allowed, 'escape', 'deep') } })).rejects.toThrow('outside the workspaces');
      await h.adapter.dispatch({ task: 'x', metadata: { workspaceRoot: join(allowed, 'real') } });
      expect(h.created).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
