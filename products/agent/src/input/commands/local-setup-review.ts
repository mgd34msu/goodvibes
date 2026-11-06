import { createSetupReviewCollector, type TerminalSetupReviewSnapshot } from '@goodvibes-jev/engine/terminal-shell/setup-review';
import 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../agent/skill-discovery.ts';
import '@goodvibes-jev/engine/sdk/platform/plugins';
import '@goodvibes-jev/engine/sdk/platform/config';
import {
  requireProviderApi,
  requireReadModels,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

export type SetupReviewSnapshot = Omit<TerminalSetupReviewSnapshot, 'serviceIssues'> & { readonly hostIntegrationIssues: string[] };

const collectSetupReview = createSetupReviewCollector<CommandContext, Record<never, never>>(
  { requireShellPaths, requireServiceRegistry, requireProviderApi, requireReadModels, requireSubscriptionManager, discoverSkills },
  {
    serviceArea: 'host',
    serviceNoun: 'host integration',
    emptyServices: 'no connected host integrations configured',
    extraSnapshot: () => ({}),
    extraIssues: () => [],
  },
);
export async function buildSetupReviewSnapshot(context: CommandContext): Promise<SetupReviewSnapshot> {
  const { serviceIssues, ...snapshot } = await collectSetupReview(context);
  return { ...snapshot, hostIntegrationIssues: serviceIssues };
}
