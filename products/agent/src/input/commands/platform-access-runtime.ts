import { createAuthCommand } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import { formatAgentRecordSource } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';

interface AuthReviewBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly externalRuntimeAuth: 'managed-outside-agent';
  readonly secretKeys: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly pendingSubscriptions: readonly string[];
}

function inspectAuthBundle(bundle: AuthReviewBundle): string {
  return [
    'Auth Review Bundle',
    `  exported at ${new Date(bundle.exportedAt).toISOString()}`,
    `  connected host auth ${bundle.externalRuntimeAuth}`,
    `  stored secrets ${bundle.secretKeys.length}`,
    `  active subscriptions ${bundle.activeSubscriptions.length}`,
    `  pending subscriptions ${bundle.pendingSubscriptions.length}`,
  ].join('\n');
}

/** `/auth` is one description shared with the other terminal app (terminal-shell/auth-review-command.ts). */
const authCommand = createAuthCommand<CommandContext, AuthReviewBundle>({
  review: (snapshot, builtinProviders) => [
    'Auth Review',
    '  connected host auth managed outside goodvibes-agent',
    `  stored secrets ${snapshot.secretKeyCount}`,
    `  built-in providers ${builtinProviders.length}${builtinProviders.length > 0 ? ` (${builtinProviders.join(', ')})` : ''}`,
    `  active subscriptions ${snapshot.activeSubscriptions}${
      snapshot.activeSubscriptions > 0
        ? ` (${snapshot.providers
            .filter((provider) => provider.activeSubscription)
            .map((provider) => provider.provider)
            .join(', ')})`
        : ''
    }`,
    `  pending subscriptions ${snapshot.pendingSubscriptions}${
      snapshot.pendingSubscriptions > 0
        ? ` (${snapshot.providers
            .filter((provider) => provider.pendingLogin)
            .map((provider) => provider.provider)
            .join(', ')})`
        : ''
    }`,
    ...snapshot.providers.map(
      (provider) => `  ${provider.provider}  auth ${provider.freshness}  finish manual  configured ${provider.configured ? 'yes' : 'no'}`,
    ),
  ],
  show: (provider, inspection) => [
    `Auth Provider ${provider}`,
    `  configured ${inspection.configured ? 'yes' : 'no'}`,
    ...(inspection.source ? [`  origin ${formatAgentRecordSource(inspection.source)}`] : []),
    `  freshness ${inspection.freshness}`,
    '  finish mode explicit manual',
    ...(inspection.redirectUri ? [`  redirect URI ${inspection.redirectUri}`] : []),
    `  active subscription ${inspection.activeSubscription ? 'yes' : 'no'}`,
    `  pending login ${inspection.pendingLogin ? 'yes' : 'no'}`,
    `  ambient API key override ${inspection.overrideAmbientApiKeys ? 'yes' : 'no'}`,
    ...(inspection.tokenType ? [`  token type ${inspection.tokenType}`] : []),
    ...(inspection.expiresAt ? [`  expires at ${new Date(inspection.expiresAt).toISOString()}`] : []),
    ...inspection.issues.map((issue) => `  issue ${issue}`),
    ...inspection.nextActions.map((action) => `  next ${action}`),
  ],
  repair: (provider, inspection) => [
    `Auth Repair ${provider}`,
    `  configured ${inspection.configured ? 'yes' : 'no'}`,
    `  freshness ${inspection.freshness}`,
    '  finish mode explicit manual',
    ...inspection.issues.map((issue) => `  issue ${issue}`),
    ...(inspection.nextActions.length > 0
      ? ['  next', ...inspection.nextActions.map((action) => `    ${action}`)]
      : ['  No active repair actions suggested.']),
  ],
  build: (base) => ({ ...base, externalRuntimeAuth: 'managed-outside-agent' }),
  inspect: (value) => inspectAuthBundle(value as AuthReviewBundle),
});

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registry.register(authCommand);
}
