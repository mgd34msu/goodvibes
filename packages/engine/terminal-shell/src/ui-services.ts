import { createUiRuntimeEvents, type UiReadModels } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import type { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
const GROUPS = {
  environment: ['workingDirectory', 'homeDirectory', 'shellPaths'],
  shell: ['keybindingsManager', 'processManager', 'profileManager', 'bookmarkManager'],
  agents: ['agentManager', 'agentMessageBus', 'contractRunner'],
  providers: ['providerRegistry', 'favoritesStore', 'benchmarkStore'],
  sessions: ['sessionManager', 'sessionOrchestration', 'sessionMemoryStore'],
  platform: [
    'configManager',
    'localUserAuthManager',
    'mcpRegistry',
    'serviceRegistry',
    'surfaceRegistry',
    'subscriptionManager',
    'secretsManager',
    'tokenAuditor',
    'replayEngine',
    'webhookNotifier',
    'focusTracker',
    'policyRuntimeState',
  ],
  planning: ['planManager', 'adaptivePlanner', 'projectPlanningService', 'projectPlanningProjectId', 'workPlanStore'],
  coordination: ['approvalBroker'],
  runtime: ['distributedRuntime', 'remoteRunnerRegistry', 'remoteSupervisor'],
} as const;
type ServiceKey = (typeof GROUPS)[keyof typeof GROUPS][number];
type UiSource = Readonly<Record<ServiceKey, unknown>> & { readonly runtimeBus: RuntimeEventBus };
export type TerminalUiServiceGroups<T extends UiSource> = {
  readonly [Group in keyof typeof GROUPS]: Readonly<Pick<T, (typeof GROUPS)[Group][number]>>;
};
function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Readonly<Pick<T, K>> {
  const selected = {} as Pick<T, K>;
  for (const key of keys) selected[key] = source[key];
  return selected;
}
/** Project the same narrow UI capabilities for each product; session ownership and extras are explicit ports. */
export function createTerminalUiServices<T extends UiSource, SessionBroker, Platform extends object, Runtime extends object>(
  source: T,
  options: {
    readonly sessionBroker: SessionBroker;
    readonly platform: Platform;
    readonly runtime: Runtime;
    readonly readModels: UiReadModels;
  },
) {
  return {
    environment: pick(source, GROUPS.environment),
    shell: pick(source, GROUPS.shell),
    agents: pick(source, GROUPS.agents),
    providers: pick(source, GROUPS.providers),
    sessions: { ...pick(source, GROUPS.sessions), sessionBroker: options.sessionBroker },
    platform: { ...pick(source, GROUPS.platform), ...options.platform },
    planning: pick(source, GROUPS.planning),
    coordination: pick(source, GROUPS.coordination),
    runtime: { ...pick(source, GROUPS.runtime), ...options.runtime },
    events: createUiRuntimeEvents(source.runtimeBus),
    readModels: options.readModels,
  };
}

export type TerminalUiRuntimeSharedServices<T extends UiSource, SessionBroker, Platform extends object, Runtime extends object> = Omit<
  TerminalUiServiceGroups<T>,
  'sessions' | 'platform' | 'runtime'
> & {
  readonly sessions: TerminalUiServiceGroups<T>['sessions'] & { readonly sessionBroker: SessionBroker };
  readonly platform: TerminalUiServiceGroups<T>['platform'] & Platform;
  readonly runtime: TerminalUiServiceGroups<T>['runtime'] & Runtime;
};
export type TerminalUiRuntimeServices<
  T extends UiSource,
  SessionBroker,
  Platform extends object,
  Runtime extends object,
> = TerminalUiRuntimeSharedServices<T, SessionBroker, Platform, Runtime> & {
  readonly events: ReturnType<typeof createUiRuntimeEvents>;
  readonly readModels: UiReadModels;
};
