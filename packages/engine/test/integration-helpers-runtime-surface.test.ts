import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { IntegrationHelperService } from '../platform/src/platform/runtime/integration/helpers.ts';

type Listener = (envelope: unknown) => void;

function service(options: { tasks?: Map<string, unknown>; onDomain?: (domain: string, listener: Listener) => () => void } = {}): IntegrationHelperService {
  const tasks = options.tasks ?? new Map();
  return new IntegrationHelperService({
    runtimeStore: {
      getState: () => ({
        session: {},
        tasks: { tasks, queuedIds: [], runningIds: [], blockedIds: [], totalCreated: 0, totalCompleted: 0, totalFailed: 0, totalCancelled: 0 },
      }),
    },
    runtimeBus: { onDomain: options.onDomain ?? (() => () => {}) },
    approvalBroker: { listApprovals: () => [] },
    remoteRunnerRegistry: { listContracts: () => [] },
    panelManager: { getTopPane: () => ({ panels: [] }), getBottomPane: () => ({ panels: [] }), getRegisteredTypes: () => [] },
  } as never);
}

describe('GET /api/tasks rows', () => {
  test('carry what a client needs to rebuild a task: cancellable and child ids', () => {
    const tasks = new Map([['t1', {
      id: 't1', kind: 'agent', title: 'work', description: 'details', status: 'running', owner: 'o',
      cancellable: true, parentTaskId: undefined, childTaskIds: ['t2'], queuedAt: 1,
    }]]);
    const rows = service({ tasks }).getTaskSnapshot().tasks as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: 't1', cancellable: true, childTaskIds: ['t2'], description: 'details' });
  });
});

describe('the review route list', () => {
  const normalise = (route: string): string => route.split('?')[0]!.replace(/(:|\{)[A-Za-z]+\}?/g, ':p');

  test('names only routes the method catalog serves, apart from the event stream it does not describe', () => {
    const served = new Set(new GatewayMethodCatalog().list()
      .filter((method) => method.http)
      .map((method) => normalise(`${method.http!.method} ${method.http!.path}`)));
    const missing = service().buildReview().routes.filter((route) => !served.has(normalise(route)));
    expect(missing).toEqual(['GET /api/events?domains=session,tasks']);
  });
});

describe('createEventStream', () => {
  test('a request aborted before the stream starts releases its subscriptions', () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const helper = service({
      onDomain: () => { subscribed += 1; return () => { unsubscribed += 1; }; },
    });
    const controller = new AbortController();
    controller.abort();

    helper.createEventStream(new Request('http://x/api/events', { signal: controller.signal }), ['session', 'tasks']);

    expect(subscribed).toBe(2);
    expect(unsubscribed).toBe(2);
  });

  test('cancelling the stream and then aborting the request does not throw', async () => {
    let unsubscribed = 0;
    const helper = service({ onDomain: () => () => { unsubscribed += 1; } });
    const controller = new AbortController();
    const response = helper.createEventStream(new Request('http://x/api/events', { signal: controller.signal }), ['session']);

    await response.body!.cancel();
    expect(() => controller.abort()).not.toThrow();
    expect(unsubscribed).toBe(1);
  });

  test('events dropped for a full buffer are announced once the stream has room again', async () => {
    const listeners: Listener[] = [];
    const helper = service({ onDomain: (_domain, listener) => { listeners.push(listener); return () => {}; } });
    const controller = new AbortController();
    const response = helper.createEventStream(new Request('http://x/api/events', { signal: controller.signal }), ['session']);
    const envelope = { type: 'SESSION_X', ts: 1, traceId: 't', sessionId: 's', source: 'x', payload: {} };

    // Nothing reads, so the 256-chunk buffer (holding `ready` already) fills and further events drop.
    for (let i = 0; i < 300; i++) listeners[0]!(envelope);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 256 && !text.includes('event: dropped'); i++) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    listeners[0]!(envelope);
    for (let i = 0; i < 4 && !text.includes('event: dropped'); i++) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    controller.abort();

    expect(text).toContain('event: dropped');
    expect(text).toMatch(/event: dropped\ndata: \{"count":\d+\}/);
  });
});
