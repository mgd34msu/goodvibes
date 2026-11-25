import { createSetupReviewCollector, type TerminalSetupReviewSnapshot } from '@goodvibes/engine/terminal-shell/setup-review';
import type { CommandContext } from '../command-registry.ts';
import { readRemoteRunnersHealth } from '@goodvibes/engine/terminal-shell/health-command';
import { capabilityBinding } from './capability-binding.ts';
import { discoverSkills } from '../../agent/skill-discovery.ts';
import {
  requireHookWorkbench,
  requireProviderApi,
  requireReadModels,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

export type SetupReviewSnapshot = Omit<TerminalSetupReviewSnapshot, 'serviceIssues'> & { readonly hostIntegrationIssues: string[] };

const collectSetupReview = createSetupReviewCollector<CommandContext, Record<never, never>>(
  { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, requireHookWorkbench, discoverSkills,
    // The remote runners are the daemon's (terminal-shell remote-health.ts).
    readRemoteRunners: (context) => readRemoteRunnersHealth(context, capabilityBinding) },
  {
    serviceArea: 'host',
    serviceNoun: 'host integration',
    emptyServices: 'no connected host integrations configured',
    extraSnapshot: () => ({}),
    // The daemon's remote runners that could not be read are said, never counted as none.
    extraChecks: (snapshot) => snapshot.remoteRunnersUnreadable
      ? [{ severity: 'warn', area: 'remote', message: `the remote runners could not be read: ${snapshot.remoteRunnersUnreadable}` }]
      : [],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  const { serviceIssues, ...snapshot } = await collectSetupReview(context);
  return { ...snapshot, hostIntegrationIssues: serviceIssues };
}
