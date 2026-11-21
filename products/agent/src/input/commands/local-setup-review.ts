import { createSetupReviewCollector, type TerminalSetupReviewSnapshot } from '@goodvibes/engine/terminal-shell/setup-review';
import type { CommandContext } from '../command-registry.ts';
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
  { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, requireHookWorkbench, discoverSkills },
  {
    serviceArea: 'host',
    serviceNoun: 'host integration',
    emptyServices: 'no connected host integrations configured',
    extraSnapshot: () => ({}),
    extraChecks: () => [],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  const { serviceIssues, ...snapshot } = await collectSetupReview(context);
  return { ...snapshot, hostIntegrationIssues: serviceIssues };
}
