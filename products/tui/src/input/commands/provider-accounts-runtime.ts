import type { CommandContext } from '../command-registry.ts';
import type { ProviderAccountRecord, ProviderAccountSnapshot } from '@/runtime/index.ts';

import { requireOperatorClient } from './runtime-services.ts';

async function loadProviderAccountSnapshot(context: CommandContext): Promise<ProviderAccountSnapshot> {
  return await requireOperatorClient(context).providers.accountSnapshot();
}

/**
 * Present a record's recommended actions as executable rows. A recommended
 * action that carries a structured command becomes a press-Enter row that RUNS
 * that command through the command registry, never a line the user has to
 * retype. Actions with no command are genuinely out-of-product steps, so they
 * stay as plain (non-executing) rows. When there is no interactive selection
 * surface, each action is printed honestly instead.
 */
export { presentRecommendedActions } from '@goodvibes-jev/engine/terminal-shell/provider-account-actions';

import { createProviderAccountCommands } from '@goodvibes-jev/engine/terminal-shell/provider-account-commands';
import { presentRecommendedActions } from '@goodvibes-jev/engine/terminal-shell/provider-account-actions';
export const { registerProviderAccountsRuntimeCommands } = createProviderAccountCommands<
  CommandContext,
  ProviderAccountRecord,
  ProviderAccountSnapshot
>({
  usage: '[review|panel|show <provider>|routes <provider>|repair <provider>]',
  load: loadProviderAccountSnapshot,
  open: (ctx) => {
    ctx.openModal?.('providers-modal');
  },
  unknown: (id) => `Unknown provider account: ${id}`,
  routes: (record) => [
    `Provider Routes ${record.providerId}`,
    `  preferred: ${record.preferredRoute}`,
    `  active: ${record.activeRoute}`,
    `  reason: ${record.activeRouteReason}`,
    ...record.routeRecords.map(
      (route) => `  ${route.route}  usable=${route.usable ? 'yes' : 'no'}  freshness=${route.freshness}  ${route.detail}`,
    ),
    ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue: ${issue}`)),
  ],
  repair: (record) => [
    `Provider Account Repair ${record.providerId}`,
    `  active route: ${record.activeRoute}`,
    `  preferred route: ${record.preferredRoute}`,
    ...(record.fallbackRisk ? [`  fallback: ${record.fallbackRisk}`] : []),
    ...record.issues.map((issue) => `  issue: ${issue}`),
  ],
  show: (record) => [
    `Provider Account ${record.providerId}`,
    `  preferredRoute: ${record.preferredRoute}`,
    `  activeRoute: ${record.activeRoute}`,
    `  authFreshness: ${record.authFreshness}`,
    `  configured: ${record.configured ? 'yes' : 'no'}`,
    `  oauthReady: ${record.oauthReady ? 'yes' : 'no'}`,
    `  pendingLogin: ${record.pendingLogin ? 'yes' : 'no'}`,
    `  availableRoutes: ${record.availableRoutes.join(', ')}`,
    `  modelCount: ${record.modelCount}`,
    `  routeReason: ${record.activeRouteReason}`,
    ...(record.fallbackRoute ? [`  fallbackRoute: ${record.fallbackRoute}`] : []),
    ...(record.fallbackRisk ? [`  fallbackRisk: ${record.fallbackRisk}`] : []),
    ...(record.expiresAt ? [`  expiresAt: ${new Date(record.expiresAt).toISOString()}`] : []),
    ...record.routeRecords.map(
      (route) => `  route ${route.route}: usable=${route.usable ? 'yes' : 'no'} freshness=${route.freshness}; ${route.detail}`,
    ),
    ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue: ${issue}`)),
    ...record.usageWindows.map((entry) => `  window: ${entry.label}; ${entry.detail}`),
    ...record.issues.map((issue) => `  issue: ${issue}`),
    ...record.notes.map((note) => `  note: ${note}`),
  ],
  review: (snapshot) => [
    'Provider Account Review',
    `  providers: ${snapshot.providers.length}`,
    `  configured: ${snapshot.configuredCount}`,
    `  issues: ${snapshot.issueCount}`,
    ...snapshot.providers.map(
      (record) =>
        `  ${record.providerId}  active=${record.activeRoute}  preferred=${record.preferredRoute}  freshness=${record.authFreshness}  models=${record.modelCount}  issues=${record.issues.length}`,
    ),
  ],
  afterRepair: (ctx, record) => presentRecommendedActions(ctx, record.providerId, record.recommendedActions),
  afterShow: (ctx, record) => presentRecommendedActions(ctx, record.providerId, record.recommendedActions),
});
