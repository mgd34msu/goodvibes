import { getPluginDirectories } from '@goodvibes/engine/platform/platform/plugins';
import type { HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
import {
  listBuiltinSubscriptionProviders,
  type ServiceRegistry,
  type SubscriptionManager,
} from '@goodvibes/engine/platform/platform/config';
import type { ProviderApi } from '@goodvibes/engine/platform/platform/providers';
import type { UiReadModels } from '@goodvibes/engine/platform/platform/runtime/ui';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
/** One setup check: `warn` and `fail` are issues; `pass` and `info` (an optional feature not in use) are not. */
export interface SetupReviewIssue {
  readonly severity: 'pass' | 'info' | 'warn' | 'fail';
  readonly area: string;
  readonly message: string;
}
export function isSetupIssue(check: SetupReviewIssue): boolean {
  return check.severity === 'warn' || check.severity === 'fail';
}
/**
 * The checks of a setup review for a report: the issues first (or a line that
 * there are none), then everything else under its own heading, so a pass is
 * never counted or shown as an issue. `separator` goes between area and message.
 */
export function setupReviewLines(checks: readonly SetupReviewIssue[], separator = ': '): string[] {
  const line = (check: SetupReviewIssue): string => `  [${check.severity.toUpperCase()}] ${check.area}${separator}${check.message}`;
  const issues = checks.filter(isSetupIssue);
  const fine = checks.filter((check) => !isSetupIssue(check));
  return [
    ...(issues.length > 0 ? ['  Issues:', ...issues.map(line)] : ['  No setup issues.']),
    ...(fine.length > 0 ? ['  Other checks:', ...fine.map(line)] : []),
  ];
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
  /** Every check, passes and informational ones included. */
  readonly checks: SetupReviewIssue[];
  /** The checks that need attention (`warn` or `fail`). */
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
    readonly requireHookWorkbench: (context: Context) => Pick<HookWorkbench, 'describeHooksFile'>;
    readonly discoverSkills: (paths: ShellPathService) => Promise<readonly unknown[]>;
  },
  policy: {
    readonly serviceArea: string;
    readonly serviceNoun: string;
    readonly emptyServices: string;
    readonly extraSnapshot: (context: Context) => Extra;
    readonly extraChecks: (snapshot: Omit<TerminalSetupReviewSnapshot, 'issues'> & Extra) => readonly SetupReviewIssue[];
  },
) {
  const {
    requireShellPaths,
    requireServiceRegistry,
    requireProviderApi,
    requireReadModels,
    requireSubscriptionManager,
    requireHookWorkbench,
    discoverSkills,
  } = bindings;
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
    // The hooks file the dispatcher loads (`tools.hooksFile`), with the reason its hooks are not active when there is one.
    const hooksFile = requireHookWorkbench(ctx).describeHooksFile();
    const managedHookCount = hooksFile.hookCount;
    const managedHookChainCount = hooksFile.chainCount;
    const checks: SetupReviewIssue[] = [
      {
        severity: providerCount > 0 ? 'pass' : 'fail',
        area: 'providers',
        message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available',
      },
      {
        // No services is an optional feature not in use, not a fault.
        severity:
          services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0
            ? 'info'
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
      {
        // Hooks are optional: no hooks file is information, a file whose hooks cannot load is an issue.
        severity: hooksFile.problem !== null ? 'warn' : hooksFile.exists ? 'pass' : 'info',
        area: 'hooks',
        message:
          hooksFile.problem !== null
            ? `no hooks from ${hooksFile.path} are active: ${hooksFile.problem}`
            : hooksFile.exists
              ? `${managedHookCount} hook(s), ${managedHookChainCount} chain(s) in ${hooksFile.path}`
              : `no hooks file (${hooksFile.path})`,
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
      checks,
      services,
    };
    checks.push(...policy.extraChecks(snapshot));
    return { ...snapshot, issues: checks.filter(isSetupIssue) };
  }
  return buildSetupReviewSnapshot;
}
