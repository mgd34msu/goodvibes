import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { existsSync } from 'node:fs';
import { createShellPathService } from '@/runtime/index.ts';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { CliCommandRuntime } from './management.ts';
import { routeConfigWrite } from '../config/daemon-config-routing.ts';
import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from './provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { appendTemporalLabel } from './temporal-label.ts';

/** The connected host's base URL when it is on another machine; undefined for this machine's daemon. */
function remoteHostBaseUrl(runtime: CliCommandRuntime): string | undefined {
  const baseUrl = resolveConnectedHostBaseUrl(runtime.configManager);
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.') ? undefined : baseUrl;
  } catch {
    return undefined;
  }
}

function readAuthPosture(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorToken = readConnectedHostOperatorToken(runtime.homeDirectory, resolveConnectedHostBaseUrl(runtime.configManager));
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath: operatorToken.path,
    operatorTokenPresent: operatorToken.present && Boolean(operatorToken.token),
  };
}
export const handleBundleCommand = createSupportBundleCommand<
  CliCommandRuntime,
  OneShotProviderServices,
  Awaited<ReturnType<typeof buildCliServicePosture>>
>(
  {
    schema: CONFIG_SCHEMA,
    createSecrets: (runtime) => createRuntimeSecretsManager({
      projectRoot: runtime.workingDirectory,
      globalHome: runtime.homeDirectory,
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configManager: runtime.configManager,
      daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
    }),
    withServices: withProviderServices,
    providerRegistry: (services) => services.providerRegistry,
    classifyProvider: classifyProviderSetup,
    servicePosture: buildCliServicePosture,
    authPosture: readAuthPosture,
    packageVersion: getPackageVersion,
    onboardingMarkerPath: getOnboardingCheckMarkerPath,
    // The connected host applies its own settings: the same routed write the settings screens use.
    routeDaemonSetting: (runtime, key, value) => routeConfigWrite(runtime.configManager, key, value, {
      homeDir: runtime.homeDirectory,
      // A host on another machine is named, so an unreachable one refuses instead of a local file being written.
      ...(remoteHostBaseUrl(runtime) ? { baseUrl: remoteHostBaseUrl(runtime) } : {}),
    }),
  },
  {
    site: 'agent.cli.bundle-export',
    providerSite: 'agent.support-bundle.setup',
    packageName: '@goodvibes-jev/agent',
    bundleType: 'goodvibes-agent.support',
    title: 'GoodVibes Agent support bundle',
    commandBase: (runtime) => runtime.cli.binary + ' bundle',
    defaultFilename: 'goodvibes-agent-bundle.json',
    detachConfig: true,
    time: (timestamp) => appendTemporalLabel(new Date(timestamp).toISOString(), timestamp),
    invalidJsonSeparator: ' ',
    exportLabel: 'Bundle exported',
    issuesKey: 'hostIntegrationIssues',
  },
);
