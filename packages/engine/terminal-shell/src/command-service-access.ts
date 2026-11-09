import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
/** A missing bound service is a wiring error; never reach for another product's service. */
export function requireContextValue<T>(value: T | null | undefined, name: string): T {
  if (value == null) throw new Error(`commandContext.${name} is required but was not wired at bootstrap`);
  return value;
}
const SERVICES = {
  requireSession: {
    path: ['session'],
    label: 'session',
  },
  requireProvider: {
    path: ['provider'],
    label: 'provider',
  },
  requireWorkspace: {
    path: ['workspace'],
    label: 'workspace',
  },
  requirePlatform: {
    path: ['platform'],
    label: 'platform',
  },
  requireOps: {
    path: ['ops'],
    label: 'ops',
  },
  requireExtensions: {
    path: ['extensions'],
    label: 'extensions',
  },
  requireReadModels: {
    path: ['platform', 'readModels'],
    label: 'platform.readModels',
  },
  requireKeybindingsManager: {
    path: ['workspace', 'keybindingsManager'],
    label: 'workspace.keybindingsManager',
  },
  requireProfileManager: {
    path: ['workspace', 'profileManager'],
    label: 'workspace.profileManager',
  },
  requireBookmarkManager: {
    path: ['workspace', 'bookmarkManager'],
    label: 'workspace.bookmarkManager',
  },
  requireSessionManager: {
    path: ['session', 'sessionManager'],
    label: 'session.sessionManager',
  },
  requireSecretsManager: {
    path: ['platform', 'secretsManager'],
    label: 'platform.secretsManager',
  },
  requireSubscriptionManager: {
    path: ['platform', 'subscriptionManager'],
    label: 'platform.subscriptionManager',
  },
  requireServiceRegistry: {
    path: ['platform', 'serviceRegistry'],
    label: 'platform.serviceRegistry',
  },
  requireLocalUserAuthManager: {
    path: ['platform', 'localUserAuthManager'],
    label: 'platform.localUserAuthManager',
  },
  requireTokenAuditor: {
    path: ['platform', 'tokenAuditor'],
    label: 'platform.tokenAuditor',
  },
  requireReplayEngine: {
    path: ['platform', 'replayEngine'],
    label: 'platform.replayEngine',
  },
  requireWebhookNotifier: {
    path: ['platform', 'webhookNotifier'],
    label: 'platform.webhookNotifier',
  },
  requireSessionMemoryStore: {
    path: ['session', 'sessionMemoryStore'],
    label: 'session.sessionMemoryStore',
  },
  requireSessionLineageTracker: {
    path: ['session', 'sessionLineageTracker'],
    label: 'session.sessionLineageTracker',
  },
  requireSessionChangeTracker: {
    path: ['session', 'changeTracker'],
    label: 'session.changeTracker',
  },
  requirePlanManager: {
    path: ['ops', 'planManager'],
    label: 'ops.planManager',
  },
  requireAdaptivePlanner: {
    path: ['ops', 'adaptivePlanner'],
    label: 'ops.adaptivePlanner',
  },
  requireSessionOrchestration: {
    path: ['ops', 'sessionOrchestration'],
    label: 'ops.sessionOrchestration',
  },
  requireForensicsRegistry: {
    path: ['extensions', 'forensicsRegistry'],
    label: 'extensions.forensicsRegistry',
  },
  requirePluginManager: {
    path: ['extensions', 'pluginManager'],
    label: 'extensions.pluginManager',
  },
  requirePolicyRuntimeState: {
    path: ['extensions', 'policyRuntimeState'],
    label: 'extensions.policyRuntimeState',
  },
  requireMcpRegistry: {
    path: ['extensions', 'mcpRegistry'],
    label: 'extensions.mcpRegistry',
  },
  requireToolRegistry: {
    path: ['extensions', 'toolRegistry'],
    label: 'extensions.toolRegistry',
  },
  requireHookWorkbench: {
    path: ['extensions', 'hookWorkbench'],
    label: 'extensions.hookWorkbench',
  },
  requireIntegrationHelpers: {
    path: ['extensions', 'integrationHelpers'],
    label: 'extensions.integrationHelpers',
  },
  requireProviderOptimizer: {
    path: ['provider', 'providerOptimizer'],
    label: 'provider.providerOptimizer',
  },
  requireFavoritesStore: {
    path: ['provider', 'favoritesStore'],
    label: 'provider.favoritesStore',
  },
  requireBenchmarkStore: {
    path: ['provider', 'benchmarkStore'],
    label: 'provider.benchmarkStore',
  },
  requireRemoteRuntime: {
    path: ['ops', 'remoteRuntime'],
    label: 'ops.remoteRuntime',
  },
  requireOperatorClient: {
    path: ['clients', 'operator'],
    label: 'clients.operator',
  },
  requirePeerClient: {
    path: ['clients', 'peer'],
    label: 'clients.peer',
  },
  requireProviderApi: {
    path: ['clients', 'providerApi'],
    label: 'clients.providerApi',
  },
  requireHookApi: {
    path: ['clients', 'hookApi'],
    label: 'clients.hookApi',
  },
  requireMcpApi: {
    path: ['clients', 'mcpApi'],
    label: 'clients.mcpApi',
  },
  requireDirectTransport: {
    path: ['clients', 'transport'],
    label: 'clients.transport',
  },
  requireAgentManager: {
    path: ['ops', 'agentManager'],
    label: 'ops.agentManager',
  },
  requireModeManager: {
    path: ['ops', 'modeManager'],
    label: 'ops.modeManager',
  },
  requireAutomationManager: {
    path: ['ops', 'automationManager'],
    label: 'ops.automationManager',
  },
} as const;
type ValueAt<Context, Path extends readonly string[]> = Path extends readonly [infer Key extends string, ...infer Rest extends string[]]
  ? Key extends keyof NonNullable<Context>
    ? ValueAt<NonNullable<Context>[Key], Rest>
    : never
  : Context;
export type TerminalCommandServiceAccessors<Context> = {
  readonly [Name in keyof typeof SERVICES]: (context: Context) => NonNullable<ValueAt<Context, (typeof SERVICES)[Name]['path']>>;
};
export function createCommandServiceAccessors<Context extends object>(): TerminalCommandServiceAccessors<Context> {
  return Object.fromEntries(
    Object.entries(SERVICES).map(([name, spec]) => [
      name,
      (context: Context) => {
        let value: unknown = context;
        for (const part of spec.path) {
          value =
            value !== null && (typeof value === 'object' || typeof value === 'function')
              ? (Reflect.get(value, part) as unknown)
              : undefined;
        }
        return requireContextValue(value, spec.label);
      },
    ]),
  ) as TerminalCommandServiceAccessors<Context>;
}
export interface CommandPathContext {
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
}
export function requireShellPaths(context: CommandPathContext): ShellPathService {
  return requireContextValue(context.workspace.shellPaths, 'workspace.shellPaths');
}
export function requirePluginPathOptions(context: CommandPathContext) {
  const paths = requireShellPaths(context);
  return { cwd: paths.workingDirectory, homeDir: paths.homeDirectory };
}
export function createCommandPathAccessors(surfaceRoot: string) {
  return {
    requireEcosystemCatalogPaths(context: CommandPathContext) {
      const paths = requireShellPaths(context);
      return {
        cwd: paths.workingDirectory,
        homeDir: paths.homeDirectory,
        projectCatalogRoot: paths.resolveProjectPath(surfaceRoot, 'ecosystem'),
        userCatalogRoot: paths.resolveUserPath(surfaceRoot, 'ecosystem'),
      };
    },
  };
}
