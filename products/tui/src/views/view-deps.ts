import type { NativeWorkLedgerModalSource } from '../runtime/native-work-ledger-host.ts';
/**
 * view-deps.ts, what the built-in modals and views are built from.
 *
 * Composed once at startup (runtime/bootstrap-shell.ts) and handed to
 * createShellViews (builtin-views.ts), which builds the always-on read models
 * (usage, fleet acts and spawn) and registers every config-modal surface.
 */

import type { ConfigManager, ServiceRegistry, SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { Orchestrator, SessionMemoryStore } from '@goodvibes/engine/platform/platform/core';
import type { MemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { HookActivityTracker, HookDispatcher, HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
import type { UserAuthManager } from '@goodvibes/engine/platform/platform/security';
import type { ProjectPlanningService, ProjectWorkPlan, KnowledgeApi } from '@goodvibes/engine/platform/platform/knowledge';
import type { SessionChangeTracker } from '@goodvibes/engine/platform/platform/sessions';
import type { PolicyRuntimeState, SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
import type { PluginsModalManager } from './modals/plugins-modal.ts';

export interface BuiltinViewDeps {
  /** The /work modal's view of the shared native host selection. */
  readonly nativeWorkLedgerSelection?: NativeWorkLedgerModalSource;
  readonly providerRegistry: ProviderRegistry;
  readonly uiServices: UiRuntimeServices;
  readonly toolRegistry?: ToolRegistry;
  /** The main orchestrator (session usage and context size). */
  readonly orchestrator?: Orchestrator;
  /** The current model's context window in tokens. */
  readonly getCtxWindow?: () => number;
  readonly requestRender?: () => void;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  /** Memory access for the Memory modal (the spine client, which routes to an adopted daemon). */
  readonly memoryRegistry?: MemoryAccess;
  readonly pluginManager?: PluginsModalManager;
  readonly hookDispatcher?: Pick<HookDispatcher, 'listHooks' | 'getChains'>;
  readonly hookWorkbench?: HookWorkbench;
  readonly hookActivityTracker?: Pick<HookActivityTracker, 'listRecent'>;
  readonly knowledgeApi?: KnowledgeApi;
  /** The files this session edited (the Changes modal's default view). */
  readonly sessionChangeTracker?: Pick<SessionChangeTracker, 'getChangedFiles'>;
  /** Report a fleet act's result (late-bound to the command context's print). */
  readonly fleetActsNotify?: (message: string) => void;
  /** Hand a spawned session id to the one-key jump affordance (late-bound). */
  readonly armFixSessionAttach?: (sessionId: string) => void;
}

/** The deps with everything the modals require resolved from the UI services. */
export type ResolvedBuiltinViewDeps = BuiltinViewDeps & {
  readonly configManager: ConfigManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlan: ProjectWorkPlan;
  readonly policyRuntimeState: PolicyRuntimeState;
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} must be wired at bootstrap for the built-in modals.`);
  return value;
}

export function resolveBuiltinViewDeps(deps: BuiltinViewDeps): ResolvedBuiltinViewDeps {
  const ui = deps.uiServices;
  return {
    ...deps,
    configManager: required(ui.platform.configManager, 'Config manager'),
    localUserAuthManager: required(ui.platform.localUserAuthManager, 'Local auth manager'),
    subscriptionManager: required(ui.platform.subscriptionManager, 'Subscription manager'),
    serviceRegistry: required(ui.platform.serviceRegistry, 'Service registry'),
    sessionMemoryStore: required(ui.sessions.sessionMemoryStore, 'Session memory store'),
    projectPlanningService: required(ui.planning.projectPlanningService, 'Project planning service'),
    projectPlanningProjectId: required(ui.planning.projectPlanningProjectId, 'Project planning project id'),
    workPlan: required(ui.planning.workPlan, 'Work plan'),
    policyRuntimeState: required(ui.platform.policyRuntimeState, 'Policy runtime state'),
  };
}
