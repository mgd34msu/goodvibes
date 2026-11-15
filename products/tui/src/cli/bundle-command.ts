import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import type { RuntimeServices } from '../runtime/services.ts';
import { readAuthPaths, withRuntimeServices } from './management-utils.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
import { SecretsManager } from '../config/secrets.ts';
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
    createSecrets: (runtime) =>
      new SecretsManager({
        projectRoot: runtime.workingDirectory,
        globalHome: runtime.homeDirectory,
        configManager: runtime.configManager,
      }),
    withServices: withRuntimeServices,
    providerRegistry: (services) => services.providerRegistry,
    classifyProvider: classifyProviderSetup,
    servicePosture: buildCliServicePosture,
    authPosture: readAuthPaths,
    packageVersion: getPackageVersion,
    onboardingMarkerPath: getOnboardingCheckMarkerPath,
    applySetting(runtime, key, value) {
      runtime.configManager.setDynamic(key, value as never);
    },
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
