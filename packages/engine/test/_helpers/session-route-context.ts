import { randomUUID } from 'node:crypto';
import type { DaemonRuntimeRouteContext } from '../../daemon-api/src/runtime-route-types.js';

const notExpected = async (): Promise<never> => { throw new Error('not expected'); };

/**
 * A data-only stand-in for the session route context: every collaborator is inert
 * except the three broker entry points a test supplies, which throw when unset so
 * an unexpected route call fails loudly. The context carries far more members than
 * the session routes read, so the one cast lives here rather than in each test file.
 */
export function makeSessionRouteContext(broker: {
  readonly steerMessage?: (input: unknown) => Promise<unknown>;
  readonly submitMessage?: (input: unknown) => Promise<unknown>;
  readonly followUpMessage?: (input: unknown) => Promise<unknown>;
}): DaemonRuntimeRouteContext {
  return {
    parseJsonBody: async (req: Request) => {
      try {
        return await req.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    parseOptionalJsonBody: async () => null,
    recordApiResponse: (_req: unknown, _path: unknown, response: Response) => response,
    requireAdmin: () => null,
    sessionBroker: {
      start: async () => {},
      steerMessage: broker.steerMessage ?? notExpected,
      submitMessage: broker.submitMessage ?? notExpected,
      followUpMessage: broker.followUpMessage ?? notExpected,
      bindAgent: async () => {},
      createSession: async (input: { id?: string }) => ({ id: input.id ?? randomUUID() }),
      getSession: () => null,
      getMessages: () => [],
      getInputs: () => [],
      closeSession: async () => null,
      reopenSession: async () => null,
      cancelInput: async () => null,
      completeAgent: async () => {},
      appendCompanionMessage: async () => null,
    },
    agentManager: { getStatus: () => null, cancel: () => {} },
    automationManager: {
      listJobs: () => [], listRuns: () => [], getRun: () => null,
      triggerHeartbeat: async () => null, cancelRun: async () => null, retryRun: async () => ({}),
      createJob: async () => ({ id: randomUUID() }), updateJob: async () => null, removeJob: async () => {},
      setEnabled: async () => null, runNow: async () => ({ id: randomUUID(), status: 'running' }),
    },
    normalizeAtSchedule: (at: unknown) => at,
    normalizeEverySchedule: (interval: unknown) => interval,
    normalizeCronSchedule: (expr: unknown) => expr,
    routeBindings: { start: async () => {}, getBinding: () => undefined },
    trySpawnAgent: () => ({ id: randomUUID(), status: 'running', task: 'test-task', tools: [], startedAt: Date.now() }),
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: null,
    runtimeDispatch: null,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('stream', { status: 200 }),
  } as unknown as DaemonRuntimeRouteContext;
}
