import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import { withRuntimeServices } from './management-utils.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../config/secrets.ts';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';

import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';

function readAuthPosture(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
  const operatorTokenPath = join(runtime.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}
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
    authPosture: readAuthPosture,
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
