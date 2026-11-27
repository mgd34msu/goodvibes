/**
 * What the System support and transfer capabilities (builtin/system-bundles.ts) read in the daemon: its providers,
 * a program's secret store (what is stored and where, never a value), and the program's setup as the daemon sees it
 * in the caller's project (models, services and sign-ins, skills, plugins, tool servers, hooks, the sandbox).
 */
import { dirname, join, resolve } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.js';
import { resolveGoodVibesDaemonHome, resolveGoodVibesTreeDirectory } from '../config/goodvibes-home.js';
import { createRuntimeSecretsManager } from '../runtime/secrets-composition.js';
import { buildSandboxReview } from '../runtime/sandbox/manager.js';
import { HookWorkbench } from '../hooks/workbench.js';
import { getPluginDirectories } from '../plugins/loader.js';
import { loadMcpEffectiveConfig } from '../mcp/config.js';
import { SkillLibrary } from '../skills/library.js';
import { ProfileManager } from '../profiles/manager.js';
import type { SetupCheck } from '../support/setup-transfer.js';
import type { CapabilityCaller } from './types.js';
import type { SystemBundleCapabilityServices } from './builtin/system-bundles.js';
import { createPluginCapabilityServices, type PluginServiceSources } from './plugins-services.js';
import type { DaemonCapabilityServiceSources } from './daemon-services.js';

/** A dispatcher view that runs nothing: the hooks file is only described here, never loaded. */
const DESCRIBE_ONLY = { clearLoaded(): void {}, loadFromFile(): void {} };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');

export function createSupportCapabilityServices(sources: DaemonCapabilityServiceSources): Pick<SystemBundleCapabilityServices, 'supportBundles'> {
  const config = sources.configManager as DaemonCapabilityServiceSources['configManager'] & Partial<Pick<ConfigManager, 'getHomeDirectory'>>;
  const goodvibesRoot = (): string => sources.shellPaths?.resolveUserPath() ?? resolveGoodVibesTreeDirectory();
  const home = (): string => sources.homeDirectory ?? config.getHomeDirectory?.() ?? dirname(goodvibesRoot());
  const project = (caller: CapabilityCaller): string => (caller.workingDirectory ? resolve(caller.workingDirectory) : config.getWorkingDirectory() ?? home());
  // A project's hooks file; a caller naming no project has none (the daemon's own folder holds no hooks file).
  const hooksFile = (caller: CapabilityCaller, programConfig: ConfigManager): string | null =>
    (caller.workingDirectory ? resolve(resolve(caller.workingDirectory), String(programConfig.get('tools.hooksFile'))) : null);
  const plugins = createPluginCapabilityServices(sources as PluginServiceSources).plugins;
  return {
    supportBundles: {
      providerRegistry: () => sources.providerRegistry,
      secrets: (caller, program, programConfig) => createRuntimeSecretsManager({
        projectRoot: project(caller), globalHome: sources.secretsManager.getGlobalHome(), surfaceRoot: program,
        configManager: programConfig, daemonHome: resolveGoodVibesDaemonHome(home()),
      }),
      presetCount: (_caller, program) => {
        try { return new ProfileManager(join(goodvibesRoot(), program, 'profiles')).list().length; } catch { return 0; }
      },
      home,
      project,
      hooksFile,
      async review(caller, program, programConfig) {
        const folder = project(caller);
        const registry = sources.serviceRegistry;
        const serviceConfigs = registry ? registry.getAll() : {};
        const services = Object.keys(serviceConfigs).sort((a, b) => a.localeCompare(b));
        const serviceIssues: string[] = [];
        for (const name of services) {
          const inspection = await registry!.inspect(name).catch(() => null);
          if (!inspection?.hasPrimaryCredential) serviceIssues.push(`${name}: missing primary credential`);
        }
        let skillCount = 0;
        try { skillCount = SkillLibrary.forPaths({ workingDirectory: folder, goodvibesRoot: goodvibesRoot(), surfaceRoot: program }).list().length; } catch { skillCount = 0; }
        let pluginList: readonly { readonly name: string }[] = [];
        let quarantinedPluginCount = 0;
        try {
          const manager = plugins.forProject(folder)?.manager;
          pluginList = manager?.list() ?? [];
          quarantinedPluginCount = manager ? pluginList.filter((plugin) => manager.getQuarantineRecord(plugin.name) !== undefined).length : 0;
        } catch { pluginList = []; }
        // The tool servers of the asking project: its own files and the owner's (mcp/config.ts), not every server the
        // daemon has started; a server's quarantine is the daemon's reading of it, when the daemon knows it.
        const known = (() => { try { return sources.mcpRegistry?.listServerSecurity() ?? []; } catch { return []; } })();
        const mcpServers = (() => {
          try {
            return loadMcpEffectiveConfig({ workingDirectory: folder, homeDirectory: home() }).servers.map(({ server }) => {
              const running = known.find((entry) => entry.name === server.name);
              return { name: server.name, trustMode: running?.trustMode ?? server.trustMode, schemaFreshness: running?.schemaFreshness };
            });
          } catch { return []; }
        })();
        const providerCount = (() => { try { return sources.providerRegistry?.listModels().length ?? 0; } catch { return 0; } })();
        const oauthProviderCount = Object.values(serviceConfigs).filter((service) => service.authType === 'oauth' && service.oauth).length;
        const builtinSubscriptionProviderCount = listBuiltinSubscriptionProviders().length;
        const activeSubscriptionCount = (() => { try { return sources.subscriptionManager?.list().length ?? 0; } catch { return 0; } })();
        const pendingSubscriptionCount = (() => { try { return sources.subscriptionManager?.listPending().length ?? 0; } catch { return 0; } })();
        const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
        const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
        const hooks = (() => {
          const path = hooksFile(caller, programConfig);
          if (path === null) return { path: 'no project named', exists: false, hookCount: 0, chainCount: 0, problem: null };
          try { return new HookWorkbench(DESCRIBE_ONLY as never, () => path).describeHooksFile(); }
          catch (error) { return { path, exists: true, hookCount: 0, chainCount: 0, problem: errorText(error) }; }
        })();
        const sandboxMcpIsolation = String(programConfig.get('sandbox.mcpIsolation'));
        const sandboxSecureModeReady = (() => { try { return buildSandboxReview(programConfig).host.secureSandboxReady; } catch { return false; } })();
        const noServices = services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0;
        const checks: SetupCheck[] = [
          { severity: providerCount > 0 ? 'pass' : 'fail', area: 'providers', message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available' },
          {
            // No services is an optional feature not in use, not a fault.
            severity: noServices ? 'info' : serviceIssues.length === 0 ? 'pass' : 'warn',
            area: 'services',
            message: noServices ? 'no services configured'
              : serviceIssues.length === 0 ? `${services.length} service(s), ${oauthProviderCount + builtinSubscriptionProviderCount} oauth provider(s), ${activeSubscriptionCount} active subscription override(s)`
                : `${serviceIssues.length} service configuration issue(s)`,
          },
          { severity: quarantinedPluginCount === 0 ? 'pass' : 'warn', area: 'plugins', message: quarantinedPluginCount === 0 ? `${pluginList.length} plugin(s) discovered` : `${quarantinedPluginCount} plugin(s) quarantined` },
          {
            severity: quarantinedMcpCount === 0 && elevatedMcpCount === 0 ? 'pass' : 'warn', area: 'mcp',
            message: quarantinedMcpCount > 0 || elevatedMcpCount > 0 ? `${quarantinedMcpCount} quarantined, ${elevatedMcpCount} elevated` : `${mcpServers.length} tool server(s) set up for this project`,
          },
          {
            // Hooks are optional: no hooks file is information, a file whose hooks cannot load is an issue.
            severity: hooks.problem !== null ? 'warn' : hooks.exists ? 'pass' : 'info', area: 'hooks',
            message: hooks.problem !== null ? `no hooks from ${hooks.path} are active: ${hooks.problem}`
              : hooks.exists ? `${hooks.hookCount} hook(s), ${hooks.chainCount} chain(s) in ${hooks.path}` : `no hooks file (${hooks.path})`,
          },
          {
            severity: sandboxSecureModeReady ? 'pass' : 'info', area: 'sandbox',
            message: sandboxSecureModeReady
              ? `bubblewrap boundary available; MCP servers: ${sandboxMcpIsolation === 'contained' ? 'contained' : 'host processes'}`
              : 'no process boundary on this host (bubblewrap missing or unusable); commands and MCP servers run as host processes',
          },
        ];
        return {
          program, providerCount, serviceCount: services.length, oauthProviderCount, builtinSubscriptionProviderCount,
          activeSubscriptionCount, pendingSubscriptionCount, serviceIssues, skillCount, pluginCount: pluginList.length,
          quarantinedPluginCount, pluginDirectories: getPluginDirectories({ cwd: folder, homeDir: home() }),
          managedHookCount: hooks.hookCount, managedHookChainCount: hooks.chainCount, mcpServerCount: mcpServers.length,
          quarantinedMcpCount, elevatedMcpCount, sandboxMcpIsolation, sandboxSecureModeReady, checks, services,
        };
      },
    },
  };
}
