import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { createStuckTurnPlaybook } from '../platform/src/platform/runtime/ops/playbooks/stuck-turn.js';
import type { OpsRuntimeContextState } from '../platform/src/platform/runtime/ops/runtime-context.js';
import type { ActiveToolCall } from '../platform/src/platform/runtime/store/domains/conversation.js';

const NOW = 1_700_000_100_000;

function contextWith(patch: (state: ReturnType<ReturnType<typeof createRuntimeStore>['getState']>) => void): OpsRuntimeContextState {
  const store = createRuntimeStore();
  store.setState((state) => {
    const next = { ...state, conversation: { ...state.conversation } };
    patch(next);
    return next;
  });
  return {
    runtimeBus: new RuntimeEventBus(),
    store,
    recoveryFilePath: '/nonexistent/recovery.jsonl',
    lastSessionPointerPath: '/nonexistent/last-session.json',
    now: () => NOW,
    lastEventAt: NOW,
    sessionRecoveryFailedCount: 0,
    detach: () => {},
  };
}

function toolCall(callId: string, state: ActiveToolCall['state']): ActiveToolCall {
  return { callId, toolName: 'edit', args: '{}', state, stateEnteredAt: NOW - 1_000, phaseTimestamps: { [state]: NOW - 1_000 } };
}

async function runCheck(context: OpsRuntimeContextState, id: string) {
  const check = createStuckTurnPlaybook(() => context).checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check.run();
}

describe('stuck-turn playbook', () => {
  test('a turn that finished long ago is not reported as exceeding the timeout', async () => {
    const context = contextWith((state) => {
      state.conversation.currentTurnId = 'turn-done';
      state.conversation.turnState = 'completed';
      state.conversation.turnStartedAt = NOW - 120_000;
      state.conversation.turnEndedAt = NOW - 110_000;
    });
    const result = await runCheck(context, 'turn.timeout-elapsed');
    expect(result.passed).toBe(true);
    expect(result.summary).not.toContain('exceeded');
  });

  test('a streaming turn past the threshold is still reported', async () => {
    const context = contextWith((state) => {
      state.conversation.currentTurnId = 'turn-live';
      state.conversation.turnState = 'streaming';
      state.conversation.turnStartedAt = NOW - 45_000;
    });
    const result = await runCheck(context, 'turn.timeout-elapsed');
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('exceeded');
  });

  test('finished tool calls left in the map are not counted as pending', async () => {
    const context = contextWith((state) => {
      state.conversation.activeToolCalls = new Map([
        ['a', toolCall('a', 'succeeded')],
        ['b', toolCall('b', 'cancelled')],
        ['c', toolCall('c', 'executing')],
      ]);
    });
    const result = await runCheck(context, 'turn.pending-tool-calls');
    expect(result.passed).toBe(false);
    expect(result.context?.pendingToolCalls).toBe(1);
  });
});

describe('session read model pending approval', () => {
  test('reads pending from the approval broker, not the gate flag', async () => {
    const { createCoreReadModels } = await import('../platform/src/platform/runtime/ui-read-models-core.js');
    const store = createRuntimeStore();
    const approvals: { status: string }[] = [{ status: 'approved' }];
    const listeners = new Set<() => void>();
    const services = {
      runtimeStore: store,
      runtimeBus: new RuntimeEventBus(),
      providerRegistry: { getCurrentModel: () => ({ contextWindow: 0 }), getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => undefined },
      approvalBroker: {
        listApprovals: () => approvals,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    } as unknown as Parameters<typeof createCoreReadModels>[0];
    const session = createCoreReadModels(services).session;
    expect(session.getSnapshot().pendingApproval).toBe(false);
    let notified = 0;
    const unsubscribe = session.subscribe(() => { notified += 1; });
    approvals.push({ status: 'pending' });
    for (const listener of listeners) listener();
    expect(notified).toBe(1);
    expect(session.getSnapshot().pendingApproval).toBe(true);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});

describe('approval snapshot pending flag', () => {
  test('awaitingDecision follows the broker, not the gate flag', async () => {
    const { IntegrationHelperService } = await import('../platform/src/platform/runtime/integration/helpers.js');
    const store = createRuntimeStore();
    const approvals = [{ status: 'denied' }, { status: 'claimed' }];
    const service = new IntegrationHelperService({
      runtimeStore: store,
      approvalBroker: { listApprovals: () => approvals },
      workingDirectory: '/nonexistent',
      homeDirectory: '/nonexistent',
    } as unknown as ConstructorParameters<typeof IntegrationHelperService>[0]);
    expect(service.getApprovalSnapshot().awaitingDecision).toBe(true);
    approvals.pop();
    expect(service.getApprovalSnapshot().awaitingDecision).toBe(false);
  });
});

describe('approval snapshot by id', () => {
  test('a named approval is returned even when newer asks push it past the first 50', async () => {
    const { IntegrationHelperService } = await import('../platform/src/platform/runtime/integration/helpers.js');
    const records = Array.from({ length: 80 }, (_, index) => ({ id: `ask-${index}`, status: 'pending' }));
    const service = new IntegrationHelperService({
      runtimeStore: createRuntimeStore(),
      approvalBroker: {
        listApprovals: (limit = 100) => records.slice(0, limit),
        getApproval: (id: string) => records.find((record) => record.id === id) ?? null,
      },
      workingDirectory: '/nonexistent',
      homeDirectory: '/nonexistent',
    } as unknown as ConstructorParameters<typeof IntegrationHelperService>[0]);
    expect((service.getApprovalSnapshot().approvals as unknown[])).toHaveLength(50);
    expect(service.getApprovalSnapshot('ask-79').approvals).toEqual([{ id: 'ask-79', status: 'pending' }]);
    expect(service.getApprovalSnapshot('missing').approvals).toEqual([]);
  });
});

describe('cockpit pending permissions', () => {
  test('counts the broker approvals still undecided, not the gate flag', async () => {
    const { createSystemObservabilityReadModels } = await import('../platform/src/platform/runtime/ui-read-models-observability-system.js');
    const approvals = [{ status: 'approved' }, { status: 'pending' }, { status: 'claimed' }];
    const services = {
      runtimeStore: createRuntimeStore(),
      approvalBroker: { listApprovals: () => approvals },
      tokenAuditor: { auditAll: () => ({ blocked: [], rotationOverdue: [], scopeViolations: [], rotationWarnings: [] }) },
      pluginManager: { list: () => [] },
      policyRuntimeState: { getSnapshot: () => ({ lastPreflightReview: undefined, lintFindings: [] }) },
      shellPaths: { workingDirectory: '/nonexistent', homeDirectory: '/nonexistent' },
    } as unknown as Parameters<typeof createSystemObservabilityReadModels>[0];
    const { cockpit } = createSystemObservabilityReadModels(services);
    expect(cockpit.getSnapshot().pendingPermissions).toBe(2);
    approvals.length = 0;
    expect(cockpit.getSnapshot().pendingPermissions).toBe(0);
  });
});
