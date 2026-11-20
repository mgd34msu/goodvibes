import type { CommandContext } from '../command-registry.ts';
import {
  buildProviderAccountSnapshot,
  type ProviderAccountRecord,
  type ProviderAccountSnapshot,
  type ProviderAuthRoute,
  type ProviderRecommendedAction,
  type ProviderRouteRecord,
} from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { requireProvider, requireServiceRegistry, requireSubscriptionManager } from './runtime-services.ts';
import { formatProviderAuthRouteId } from '../../provider-auth-route-display.ts';

function formatRouteList(routes: readonly ProviderAuthRoute[]): string {
  return routes.map((route) => formatProviderAuthRouteId(route)).join(', ');
}

/** A repair step as the owner types it: the sentence, then the command when one exists. */
function formatAction(action: ProviderRecommendedAction): string {
  return action.command ? `${action.description} (/${[action.command.name, ...action.command.args].join(' ')})` : action.description;
}

function formatRouteRecord(route: ProviderRouteRecord): string {
  return `${formatProviderAuthRouteId(route.route)}  ${route.usable ? 'usable' : 'blocked'}  auth ${route.freshness}  ${route.detail}`;
}

async function loadProviderAccountSnapshot(context: CommandContext): Promise<ProviderAccountSnapshot> {
  return await buildProviderAccountSnapshot({
    providerRegistry: requireProvider(context).providerRegistry,
    serviceRegistry: requireServiceRegistry(context),
    subscriptionManager: requireSubscriptionManager(context),
    // Without a store only the environment is read.
    secretsManager: context.platform.secretsManager ?? { get: async () => null },
  });
}

import { createProviderAccountCommands } from '@goodvibes-jev/engine/terminal-shell/provider-account-commands';
import { commandRefusal } from './confirmation.ts';

const CONNECTED_HOST_SIGN_IN = 'The Agent keeps no daemon or listener session: it connects to a GoodVibes host that manages its own sign-in. Sign in from the terminal app (goodvibes) or the web app of that host.';

export const { registerProviderAccountsRuntimeCommands } = createProviderAccountCommands<
  CommandContext,
  ProviderAccountRecord,
  ProviderAccountSnapshot
>({
  load: loadProviderAccountSnapshot,
  open: (ctx) => {
    ctx.print(
      'Open Agent Workspace -> Start -> Sign in to a provider for the workspace view, or run /accounts review for compact command output.',
    );
  },
  unknown: (id) => `Unknown provider account ${id}`,
  routes: (record) => [
    `Provider Routes ${record.providerId}`,
    `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
    `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
    `  reason ${record.activeRouteReason}`,
    ...record.routeRecords.map((route) => `  ${formatRouteRecord(route)}`),
    ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue ${issue}`)),
  ],
  repair: (record) => [
    `Provider Account Repair ${record.providerId}`,
    `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
    `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
    ...(record.fallbackRisk ? [`  routing risk ${record.fallbackRisk}`] : []),
    ...record.issues.map((issue) => `  issue ${issue}`),
    ...(record.recommendedActions.length > 0
      ? ['  next', ...record.recommendedActions.map((action) => `    ${formatAction(action)}`)]
      : ['  No active repair actions suggested.']),
  ],
  show: (record) => [
    `Provider Account ${record.providerId}`,
    `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
    `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
    `  auth freshness ${record.authFreshness}`,
    `  configured ${record.configured ? 'yes' : 'no'}`,
    `  OAuth ready ${record.oauthReady ? 'yes' : 'no'}`,
    `  pending login ${record.pendingLogin ? 'yes' : 'no'}`,
    `  available routes ${formatRouteList(record.availableRoutes)}`,
    `  model count ${record.modelCount}`,
    `  route reason ${record.activeRouteReason}`,
    ...(record.fallbackRoute ? [`  fallback route ${formatProviderAuthRouteId(record.fallbackRoute)}`] : []),
    ...(record.fallbackRisk ? [`  routing risk ${record.fallbackRisk}`] : []),
    ...(record.expiresAt ? [`  expires at ${new Date(record.expiresAt).toISOString()}`] : []),
    ...record.routeRecords.map((route) => `  route ${formatRouteRecord(route)}`),
    ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue ${issue}`)),
    ...record.usageWindows.map((entry) => `  window ${entry.label}, ${entry.detail}`),
    ...record.issues.map((issue) => `  issue ${issue}`),
    ...record.notes.map((note) => `  note ${note}`),
    ...record.recommendedActions.map((action) => `  next ${formatAction(action)}`),
  ],
  review: (snapshot) => [
    'Provider Account Review',
    `  providers ${snapshot.providers.length}`,
    `  configured ${snapshot.configuredCount}`,
    `  issues ${snapshot.issueCount}`,
    ...snapshot.providers.map(
      (record) =>
        `  ${record.providerId}  active route ${formatProviderAuthRouteId(record.activeRoute)}  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}  auth ${record.authFreshness}  models ${record.modelCount}  issues ${record.issues.length}`,
    ),
  ],
  // The Agent holds no daemon or listener session: the host it connects to manages its own sign-in.
  signIn: async () => { throw commandRefusal(CONNECTED_HOST_SIGN_IN); },
  signOut: async () => { throw commandRefusal(CONNECTED_HOST_SIGN_IN); },
});
