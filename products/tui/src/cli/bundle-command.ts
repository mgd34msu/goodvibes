import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import { readAuthPaths } from './management-utils.ts';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveRouterDeps } from '@goodvibes-jev/engine/platform/platform/tools';
import { applyDaemonConfigWrites } from '@goodvibes-jev/engine/platform/platform/config';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { readConnectedDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import { resolveDaemonTarget } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target-resolver';
import { bearerFor } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target';
import { RefusalError } from '@goodvibes-jev/engine/errors';

import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';

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
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      configManager: runtime.configManager,
      daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
    }),
    withServices: withProviderServices,
    providerRegistry: (services) => services.providerRegistry,
    classifyProvider: classifyProviderSetup,
    servicePosture: buildCliServicePosture,
    authPosture: readAuthPaths,
    packageVersion: getPackageVersion,
    onboardingMarkerPath: getOnboardingCheckMarkerPath,
    // The daemon applies its own settings as one update; with none running the import writes its file for it to read at start.
    // A connected daemon (daemon.connectedHost.url) gets them with its own bound credential, or nothing is sent.
    routeDaemonSettings: (runtime, entries) => {
      const deps = resolveRouterDeps(runtime.configManager);
      if (!readConnectedDaemonOrigin((key) => runtime.configManager.get(key))) return applyDaemonConfigWrites(entries, deps);
      const resolution = resolveDaemonTarget({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory });
      if (!resolution.ok) throw new RefusalError(resolution.refusal);
      const { origin, credential } = resolution.target;
      return applyDaemonConfigWrites(entries, { ...deps, endpoint: {
        baseUrl: origin.baseUrl,
        token: credential ? bearerFor(credential, origin.baseUrl) : undefined,
        source: `the connected daemon at ${origin.baseUrl}`,
      } });
    },
  },
  {
    site: 'terminal-shell.support-bundle.export',
    providerSite: 'tui.support-bundle.setup',
    packageName: 'goodvibes',
    bundleType: 'goodvibes.support',
    title: 'GoodVibes support bundle',
    commandBase: () => 'goodvibes support-bundle',
    defaultFilename: 'goodvibes-bundle.json',
    detachConfig: false,
    time: (timestamp) => new Date(timestamp).toISOString(),
    invalidJsonSeparator: ': ',
    exportLabel: 'Support bundle exported',
    issuesKey: 'serviceIssues',
  },
);
