/**
 * approvals-view-liveness.test.ts
 *
 * Two ways the approvals panel used to show a wrong list without saying so: a
 * pushed transition landing while a list request was in flight was overwritten
 * by the older list reply, and a daemon that accepted a connection and never
 * answered froze the panel on its last read.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { createApprovalsView } from '../../runtime/client/approvals-view.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function approval(id: string, status: string): SharedApprovalRecord {
  return {
    id,
    callId: `call-${id}`,
    status,
    request: { callId: `call-${id}`, tool: 'bash', args: {}, category: 'exec', analysis: { risk: 'low', reasons: [] } },
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    audit: [],
  } as unknown as SharedApprovalRecord;
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe('approvals view: a push that lands during a list read survives it', () => {
  test('a decision pushed while the list is in flight is not rolled back by the list reply', async () => {
    let releaseList: (reply: unknown) => void = () => {};
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(): Promise<T> => await new Promise<T>((resolve) => { releaseList = resolve as (reply: unknown) => void; }),
    };
    let push: (notice: { approval: unknown; createdAt: number }) => void = () => {};
    const view = createApprovalsView({
      verbs,
      localBroker: { listApprovals: () => [] },
      subscribe: async (handlers) => {
        push = handlers.onUpdate as typeof push;
        return { close: () => {} };
      },
    });

    view.start();
    await flush();
    // The daemon computed this list before the decision happened.
    push({ approval: approval('a1', 'approved'), createdAt: 2 });
    push({ approval: approval('a2', 'pending'), createdAt: 2 });
    releaseList({ approvals: [approval('a1', 'pending')] });
    await flush();

    expect(view.snapshot().approvals.map((row) => row.id)).toEqual(['a2']);
    view.stop();
  });

  test('a stream that ends before its open resolves is not reported as live', async () => {
    let finishOpen: (value: { close: () => void }) => void = () => {};
    let closed = 0;
    const view = createApprovalsView({
      verbs: { probe: () => ({ available: true }), invoke: async <T,>(): Promise<T> => ({ approvals: [] }) as T },
      localBroker: { listApprovals: () => [] },
      subscribe: async (handlers) => {
        handlers.onTerminate(new Error('closed by proxy'));
        return await new Promise((resolve) => { finishOpen = resolve; });
      },
    });

    view.start();
    await flush();
    finishOpen({ close: () => { closed += 1; } });
    await flush();

    expect(view.snapshot().liveUpdates).toBe(false);
    expect(closed).toBe(1);
    view.stop();
  });
});

describe('daemon verb caller: a silent daemon does not hang the caller', () => {
  function homeWithToken(): { home: string; cleanup: () => void } {
    const home = makeProjectTempDir('gv-verb-timeout');
    const path = connectedHostOperatorTokenPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ token: 'operator-token-value' }));
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  test('an abandoned call rejects naming the timeout, and the next refresh starts a new request', async () => {
    const { home, cleanup } = homeWithToken();
    try {
      const controllers: AbortController[] = [];
      let requests = 0;
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        requests += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as typeof fetch;
      const verbs = createAgentDaemonVerbCaller({
        configManager: { get: (key: string) => ({ 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421 } as Record<string, unknown>)[key] } as never,
        homeDirectory: home,
        fetchImpl,
        invokeSignal: () => {
          const controller = new AbortController();
          controllers.push(controller);
          return controller.signal;
        },
      });
      const view = createApprovalsView({ verbs, localBroker: { listApprovals: () => [] } });

      const first = view.refresh();
      await flush();
      controllers[0]!.abort();
      const snapshot = await first;
      expect(snapshot.hostRecordRead).toBe(false);
      expect(snapshot.unavailableReason).toContain('no answer from the connected host');

      const second = view.refresh();
      await flush();
      expect(requests).toBe(2);
      controllers[1]!.abort();
      await second;
    } finally {
      cleanup();
    }
  });

  test('a host that sends headers and then stalls the body is a timeout, not an empty answer', async () => {
    const { home, cleanup } = homeWithToken();
    try {
      const controller = new AbortController();
      const fetchImpl = ((_url: string, init?: RequestInit) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      })) as unknown as typeof fetch;
      const verbs = createAgentDaemonVerbCaller({
        configManager: { get: (key: string) => ({ 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421 } as Record<string, unknown>)[key] } as never,
        homeDirectory: home,
        fetchImpl,
        invokeSignal: () => controller.signal,
      });
      const view = createApprovalsView({ verbs, localBroker: { listApprovals: () => [] } });

      const pending = view.refresh();
      await flush();
      controller.abort();
      const snapshot = await pending;
      expect(snapshot.hostRecordRead).toBe(false);
      expect(snapshot.unavailableReason).toContain('no answer from the connected host');
    } finally {
      cleanup();
    }
  });
});
