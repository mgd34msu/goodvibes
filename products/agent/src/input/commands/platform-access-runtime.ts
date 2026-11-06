import { createAuthBundleHandler } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import { createAuthReviewHandler } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import 'node:fs';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import '@goodvibes-jev/engine/sdk/platform/config';
import '@/runtime/index.ts';
import { formatAgentRecordSource } from '../../agent/record-labels.ts';
import { requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { stripYesFlag } from './confirmation.ts';

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

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'auth',
    description: 'Review provider auth posture and export redacted auth review bundles',
    hidden: true,
    usage: '[review|show <provider>|repair <provider>|bundle export <path> --yes|bundle inspect <path>]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = commandArgs[0] ?? 'review';
      if (sub === 'local') {
        ctx.print(
          [
            'Connected-host auth management is outside GoodVibes Agent.',
            'Agent connects to a GoodVibes host owned outside this package and does not create, delete, rotate, revoke, or clear connected-host auth users, sessions, or bootstrap credentials.',
            'Use the owning GoodVibes host for connected-host auth administration.',
            'Agent auth commands available here: /auth review, /auth show <provider>, /auth repair <provider>, /auth bundle export <path> --yes, /auth bundle inspect <path>.',
          ].join('\n'),
        );
        return;
      }
      if (sub === 'login') {
        ctx.print(
          [
            'Connected-host login is outside GoodVibes Agent.',
            'Agent does not create, exchange, store, rotate, revoke, or clear connected-host sessions.',
            'Use the owning GoodVibes host for connected-host auth administration.',
          ].join('\n'),
        );
        return;
      }

      const shellPaths = requireShellPaths(ctx);
      const subscriptions = requireSubscriptionManager(ctx);
      const serviceRegistry = requireServiceRegistry(ctx);
      const secretsManager = requireSecretsManager(ctx);
      if (await handleAuthReview(commandArgs, ctx, { serviceRegistry, subscriptionManager: subscriptions, secretsManager })) return;

      if (
        await handleAuthBundle(commandArgs, ctx, {
          secretsManager,
          subscriptions,
          resolvePath: (path) => shellPaths.resolveWorkspacePath(path),
          confirmed: parsed.yes,
        })
      )
        return;
      ctx.print('Usage: /auth [review|show <provider>|bundle export <path> --yes|bundle inspect <path>]');
    },
  });
}

const handleAuthReview = createAuthReviewHandler<CommandContext>({
  reportFailure: true,
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
});

const handleAuthBundle = createAuthBundleHandler<CommandContext, AuthReviewBundle>({
  confirmExport: true,
  reportReadFailure: true,
  build: (base) => ({ ...base, externalRuntimeAuth: 'managed-outside-agent' }),
  inspect: (value) => inspectAuthBundle(value as AuthReviewBundle),
});
