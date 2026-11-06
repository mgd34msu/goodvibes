import { createSupportBundleCommand } from '@goodvibes-jev/engine/terminal-shell/support-bundle-command';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { existsSync } from 'node:fs';
import 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { getOnboardingCheckMarkerPath } from '../runtime/onboarding/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { SecretsManager } from '../config/secrets.ts';
import { withRuntimeServices, type CliCommandRuntime } from './management.ts';

import { getPackageVersion } from './help.ts';
import { classifyProviderSetup } from './provider-classification.ts';
import { buildCliServicePosture } from './service-posture.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { appendTemporalLabel } from './temporal-label.ts';

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
      runtime.configManager.setDynamic(key, value);
    },
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
