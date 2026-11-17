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
    sessionBroker: { listSessions: () => [] },
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

  test('is the method catalog\'s HTTP routes, every one of them', () => {
    const served = new Set(new GatewayMethodCatalog().list()
      .filter((method) => method.http)
      .map((method) => normalise(`${method.http!.method} ${method.http!.path}`)));
    const listed = new Set(service().buildReview().routes.map(normalise));
    expect([...served].filter((route) => !listed.has(route))).toEqual([]);
    expect([...listed].filter((route) => !served.has(route))).toEqual([]);
  });
});
