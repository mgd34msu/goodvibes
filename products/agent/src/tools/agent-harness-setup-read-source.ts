import { captureSecretsReadSource, captureSubscriptionReadSource, captureServiceReadSource } from '@goodvibes-jev/engine/platform/platform/config';
import { captureFileIdentities } from '@goodvibes-jev/engine/platform/platform/security';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { setupWizardCheckpointPath } from '../agent/setup-wizard-checkpoint.ts';
import { getOnboardingRuntimeStatePath, getOnboardingCheckMarkerPath, getOnboardingCompletionMarkerPath } from '../runtime/onboarding/index.ts';

/**
 * A check that the facts a setup status read is built from did not change
 * while it ran. Each owner compares its own revision (settings, stored
 * credentials, subscriptions, services, the model catalog); the setup files
 * and the local auth store are one `stat` each. Every guard runs once per
 * check, and a refusal names the store that changed.
 */
export function captureSetupReadSource(context: CommandContext): () => void {
  const guards: (() => void)[] = [retainCliConfig(context.platform.configManager).assertCurrent];
  const shellPaths = requireShellPaths(context);
  const files = [setupWizardCheckpointPath(shellPaths), getOnboardingRuntimeStatePath(shellPaths, 'project'),
    getOnboardingCheckMarkerPath(shellPaths, 'user'), getOnboardingCompletionMarkerPath(shellPaths, 'user')];
  const auth = context.platform.localUserAuthManager;
  if (auth) {
    const inspection = auth.inspect();
    files.push(inspection.userStorePath, inspection.bootstrapCredentialPath);
  }
  guards.push(captureFileIdentities('setup state', files));
  const secrets = context.platform.secretsManager;
  if (secrets) guards.push(captureSecretsReadSource(secrets));
  const subscriptions = context.platform.subscriptionManager;
  if (subscriptions) guards.push(captureSubscriptionReadSource(subscriptions));
  const services = context.platform.serviceRegistry;
  if (services) guards.push(captureServiceReadSource(services));
  const catalog = context.provider.providerRegistry.captureProviderCatalogIds();
  guards.push(() => catalog.assertCurrent());
  return () => { for (const guard of guards) guard(); };
}
