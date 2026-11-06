import { existsSync, readFileSync } from 'node:fs';
import { getPluginDirectories } from '@goodvibes-jev/engine/sdk/platform/plugins';
import {
  listBuiltinSubscriptionProviders,
  type ServiceRegistry,
  type SubscriptionManager,
} from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderApi } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { UiReadModels } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
export interface SetupReviewIssue {
  readonly severity: 'pass' | 'warn' | 'fail';
  readonly area: string;
  readonly message: string;
}
export interface TerminalSetupReviewSnapshot {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly oauthProviderCount: number;
  readonly builtinSubscriptionProviderCount: number;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly serviceIssues: string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly issues: SetupReviewIssue[];
  readonly services: string[];
}
export function createSetupReviewCollector<
  Context extends {
    readonly session: {
      readonly runtime: {
        readonly sessionId: string;
      };
    };
    readonly ops: {
      readonly remoteRuntime?:
        | {
            listContracts(): readonly unknown[];
          }
        | undefined;
    };
  },
  Extra extends object,
>(
  bindings: {
    readonly requireShellPaths: (context: Context) => ShellPathService;
    readonly requireServiceRegistry: (context: Context) => Pick<ServiceRegistry, 'getAll' | 'inspect'>;
    readonly requireProviderApi: (context: Context) => Pick<ProviderApi, 'listModels'>;
    readonly requireReadModels: (context: Context) => Pick<UiReadModels, 'security'>;
    readonly requireSubscriptionManager: (context: Context) => Pick<SubscriptionManager, 'list' | 'listPending'>;
    readonly discoverSkills: (paths: ShellPathService) => Promise<readonly unknown[]>;
  },
  policy: {
    readonly serviceArea: string;
    readonly serviceNoun: string;
    readonly emptyServices: string;
    readonly extraSnapshot: (context: Context) => Extra;
    readonly extraIssues: (snapshot: TerminalSetupReviewSnapshot & Extra) => readonly SetupReviewIssue[];
  },
) {
  const { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, discoverSkills } =
    bindings;
  async function buildSetupReviewSnapshot(ctx: Context) {
    const shellPaths = requireShellPaths(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const services = Object.keys(serviceRegistry.getAll()).sort((a, b) => a.localeCompare(b));
    const serviceConfigs = serviceRegistry.getAll();
    const serviceIssues: string[] = [];
    for (const name of services) {
      const inspection = await serviceRegistry.inspect(name);
      if (!inspection?.hasPrimaryCredential) {
        serviceIssues.push(`${name}: missing primary credential`);
      }
    }
    const skills = await discoverSkills(shellPaths);
    const security = requireReadModels(ctx).security.getSnapshot();
    const plugins = security.plugins;
    const mcpServers = security.mcpServers;
    const pluginDirectories = getPluginDirectories({
      cwd: shellPaths.workingDirectory,
      homeDir: shellPaths.homeDirectory,
    });
    const providerCount = (await requireProviderApi(ctx).listModels()).length;
    const remoteRunnerCount = ctx.ops.remoteRuntime?.listContracts().length ?? 0;
    const oauthProviderCount = Object.values(serviceConfigs).filter((service) => service.authType === 'oauth' && service.oauth).length;
    const builtinSubscriptionProviderCount = listBuiltinSubscriptionProviders().length;
    const subscriptionManager = requireSubscriptionManager(ctx);
    const activeSubscriptionCount = subscriptionManager.list().length;
    const pendingSubscriptionCount = subscriptionManager.listPending().length;
    const extra = policy.extraSnapshot(ctx);
    const quarantinedPluginCount = plugins.filter((plugin) => plugin.quarantined).length;
    const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
    const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
    const hooksPath = shellPaths.resolveProjectPath('hooks.managed.json');
    let managedHookCount = 0;
    let managedHookChainCount = 0;
    if (existsSync(hooksPath)) {
      try {
        const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as {
          hooks?: unknown[] | undefined;
          chains?: unknown[] | undefined;
        };
        managedHookCount = parsed.hooks?.length ?? 0;
        managedHookChainCount = parsed.chains?.length ?? 0;
      } catch {
        // Ignore malformed hook config during snapshot collection.
      }
    }
    const issues: SetupReviewIssue[] = [
      {
        severity: providerCount > 0 ? 'pass' : 'fail',
        area: 'providers',
        message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available',
      },
      {
        severity:
          services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0
            ? 'warn'
            : serviceIssues.length === 0
              ? 'pass'
              : 'warn',
        area: policy.serviceArea,
        message:
          services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0
            ? policy.emptyServices
            : serviceIssues.length === 0
              ? `${services.length} ${policy.serviceNoun}(s), ${oauthProviderCount + builtinSubscriptionProviderCount} oauth provider(s), ${activeSubscriptionCount} active subscription override(s)`
              : `${serviceIssues.length} ${policy.serviceNoun} configuration issue(s)`,
      },
      {
        severity: quarantinedPluginCount === 0 ? 'pass' : 'warn',
        area: 'plugins',
        message:
          quarantinedPluginCount === 0 ? `${plugins.length} plugin(s) discovered` : `${quarantinedPluginCount} plugin(s) quarantined`,
      },
      {
        severity: quarantinedMcpCount === 0 && elevatedMcpCount === 0 ? 'pass' : 'warn',
        area: 'mcp',
        message:
          quarantinedMcpCount > 0 || elevatedMcpCount > 0
            ? `${quarantinedMcpCount} quarantined, ${elevatedMcpCount} elevated`
            : `${mcpServers.length} server(s) known`,
      },
    ];
    const snapshot = {
      sessionId: ctx.session.runtime.sessionId,
      providerCount,
      serviceCount: services.length,
      oauthProviderCount,
      builtinSubscriptionProviderCount,
      activeSubscriptionCount,
      pendingSubscriptionCount,
      serviceIssues,
      skillCount: skills.length,
      pluginCount: plugins.length,
      quarantinedPluginCount,
      pluginDirectories,
      managedHookCount,
      managedHookChainCount,
      mcpServerCount: mcpServers.length,
      quarantinedMcpCount,
      elevatedMcpCount,
      remoteRunnerCount,
      ...extra,
      issues,
      services,
    };
    issues.push(...policy.extraIssues(snapshot));
    return snapshot;
  }
  return buildSetupReviewSnapshot;
}
