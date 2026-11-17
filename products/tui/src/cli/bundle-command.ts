import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import type { RuntimeServices } from '../runtime/services.ts';
import { readAuthPaths, withRuntimeServices } from './management-utils.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { applyRoutedConfigWrite } from '@goodvibes-jev/engine/platform/platform/tools';
import { createRuntimeSecretsManager, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';

import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';

export const handleBundleCommand = createSupportBundleCommand<
  CliCommandRuntime,
  RuntimeServices,
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
    withServices: withRuntimeServices,
    providerRegistry: (services) => services.providerRegistry,
    classifyProvider: classifyProviderSetup,
    servicePosture: buildCliServicePosture,
    authPosture: readAuthPaths,
    packageVersion: getPackageVersion,
    onboardingMarkerPath: getOnboardingCheckMarkerPath,
    // The daemon applies its own settings; with none running its file is written for it to read at start.
    routeDaemonSetting: (runtime, key, value) => applyRoutedConfigWrite(runtime.configManager, key, value),
  },
  {
    site: 'terminal-shell.support-bundle.export',
    providerSite: 'tui.support-bundle.setup',
    packageName: '@goodvibes-jev/tui',
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
