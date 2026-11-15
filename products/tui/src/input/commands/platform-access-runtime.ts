import { createAuthBundleHandler } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import { createAuthReviewHandler } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import { buildUrl } from '@goodvibes-jev/engine/transport-http';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/pairing';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import { handleLocalAuthCommand } from './local-auth-runtime.ts';
import { registerUpdateCommand } from './update-runtime.ts';
import '@/runtime/index.ts';
import {
  requireProfileManager,
  requireSecretsManager,
  requireServiceRegistry,
  requireShellPaths,
  requireSubscriptionManager,
} from './runtime-services.ts';

interface AuthReviewBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly daemonLoginUrl: string;
  readonly listenerLoginUrl: string;
  readonly secretKeys: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly pendingSubscriptions: readonly string[];
}

function inspectAuthBundle(bundle: AuthReviewBundle): string {
  return [
    'Auth Review Bundle',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  daemonLoginUrl: ${bundle.daemonLoginUrl}`,
    `  listenerLoginUrl: ${bundle.listenerLoginUrl}`,
    `  stored secrets: ${bundle.secretKeys.length}`,
    `  active subscriptions: ${bundle.activeSubscriptions.length}`,
    `  pending subscriptions: ${bundle.pendingSubscriptions.length}`,
  ].join('\n');
}

const AUTH_LOGIN_TIMEOUT_MS = 15_000;

type ServiceTarget = 'daemon' | 'listener';

/** The secret-store key a service session token is kept under unless the owner names another. */
function sessionTokenKey(target: ServiceTarget, override: string | undefined): string {
  return override ?? `${target.toUpperCase()}_SESSION_TOKEN`;
}

/**
 * The service URL a password or session token may be sent to, or why not:
 * plain http carries them readable by anyone on the path, so it is accepted
 * only for this machine.
 */
function serviceBaseUrl(ctx: CommandContext, raw: string, action: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    ctx.print(`${action}: "${raw}" is not a URL. Give the service's base URL, for example https://host.example:3421. Nothing was sent.`);
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    ctx.print(`${action}: ${url.protocol} is not a web address. Use https:// (or http:// for this machine). Nothing was sent.`);
    return null;
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    ctx.print(`${action}: ${url.host} is another machine and http:// would send the credential unencrypted. Use https://${url.host}${url.pathname === '/' ? '' : url.pathname}. Nothing was sent.`);
    return null;
  }
  return url;
}

async function exchangeServiceLogin(
  ctx: CommandContext,
  input: { target: ServiceTarget; baseUrl: URL; username: string; password: string; secretKey: string },
): Promise<void> {
  try {
    const url = buildUrl(input.baseUrl.href, '/login');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: input.username, password: input.password }),
      signal: AbortSignal.timeout(AUTH_LOGIN_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body is not echoed: a login endpoint may reflect the submitted credentials.
      ctx.print(`Auth login failed (HTTP ${response.status}). Check the base URL, username and password, then retry.`);
      return;
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== 'string') {
      ctx.print('Auth login response did not include a session token.');
      return;
    }
    await requireSecretsManager(ctx).set(input.secretKey, body.token);
    ctx.print([
      `Signed in to the ${input.target} at ${input.baseUrl.origin} as ${input.username}; the session token is in secure storage as ${input.secretKey}.`,
      `  The session stays valid on the ${input.target} until it expires or you run /auth logout ${input.target} ${input.baseUrl.origin}${input.secretKey === sessionTokenKey(input.target, undefined) ? '' : ` ${input.secretKey}`}.`,
    ].join('\n'));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    ctx.print(
      timedOut
        ? `Auth login timed out after ${AUTH_LOGIN_TIMEOUT_MS / 1000}s waiting for ${input.baseUrl.origin}. Nothing was stored.`
        : `Auth login failed: ${error instanceof Error ? error.message : String(error)}. Nothing was stored.`,
    );
  }
}

/**
 * Ends a service session: the daemon revokes it (its local-auth session route,
 * authorised by the session itself), and the token is removed from secure
 * storage either way. The listener has no revoke route, so its session can
 * only be forgotten here and lapses at its expiry.
 */
async function endServiceSession(
  ctx: CommandContext,
  input: { target: ServiceTarget; baseUrl: URL; secretKey: string },
): Promise<void> {
  const secrets = requireSecretsManager(ctx);
  const token = await secrets.get(input.secretKey);
  if (!token) {
    ctx.print(`No ${input.target} session is stored as ${input.secretKey}; nothing to sign out of. /auth login ${input.target} <baseUrl> <username> signs in.`);
    return;
  }
  let revoked: string;
  if (input.target === 'listener') {
    revoked = 'The listener has no sign-out route, so the session lapses at its expiry.';
  } else {
    try {
      const response = await fetch(buildUrl(input.baseUrl.href, `/api/local-auth/sessions/${encodeURIComponent(token)}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(AUTH_LOGIN_TIMEOUT_MS),
      });
      revoked = response.ok
        ? 'The daemon revoked the session.'
        : response.status === 401 || response.status === 404
          ? 'The daemon no longer knows the session (it expired or was revoked already).'
          : `The daemon did not revoke the session (HTTP ${response.status}${response.status === 403 ? ': only an admin may revoke sessions there' : ''}); it lapses at its expiry, or an admin revokes it with /local-auth revoke-session.`;
    } catch (error) {
      revoked = `The daemon could not be reached (${error instanceof Error ? error.message : String(error)}); the session lapses at its expiry.`;
    }
  }
  await secrets.delete(input.secretKey);
  ctx.print(`Signed out of the ${input.target} at ${input.baseUrl.origin}: ${revoked} The stored token ${input.secretKey} was removed.`);
}

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'login',
    description: 'Front-door login flow for provider subscriptions and local service sessions',
    usage: '[provider <name> start|finish <code>|service <daemon|listener> <baseUrl> <username> [password] [secretKey]]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const target = (args[0] ?? '').toLowerCase();
      if (target === 'provider') {
        const provider = args[1];
        const mode = args[2]?.toLowerCase();
        if (!provider || !mode) {
          ctx.print('Usage: /login provider <name> start|finish <code>');
          return;
        }
        if (ctx.executeCommand) {
          await ctx.executeCommand('subscription', ['login', provider, mode, ...args.slice(3)]);
          return;
        }
        ctx.print(`Use /subscription login ${provider} ${mode}${args[3] ? ` ${args[3]}` : ''}`);
        return;
      }
      if (target === 'service') {
        if (ctx.executeCommand) {
          await ctx.executeCommand('auth', ['login', ...args.slice(1)]);
          return;
        }
        ctx.print('Use /auth login <daemon|listener> <baseUrl> <username> [password] [secretKey]');
        return;
      }
      ctx.print(
        'Usage: /login [provider <name> start|finish <code>|service <daemon|listener> <baseUrl> <username> [password] [secretKey]]',
      );
    },
  });

  registry.register({
    name: 'logout',
    description: 'Front-door logout flow for provider subscription sessions and supported overrides',
    usage: '[provider <name>|service <daemon|listener> <baseUrl> [secretKey]]',
    async handler(args, ctx) {
      const target = (args[0] ?? '').toLowerCase();
      if (target === 'service') {
        if (ctx.executeCommand) {
          await ctx.executeCommand('auth', ['logout', ...args.slice(1)]);
          return;
        }
        ctx.print('Use /auth logout <daemon|listener> <baseUrl> [secretKey]');
        return;
      }
      if (target !== 'provider' || !args[1]) {
        ctx.print('Usage: /logout provider <name> | /logout service <daemon|listener> <baseUrl> [secretKey]');
        return;
      }
      if (ctx.executeCommand) {
        await ctx.executeCommand('subscription', ['logout', args[1]]);
        return;
      }
      ctx.print(`Use /subscription logout ${args[1]}`);
    },
  });

  registry.register({
    name: 'install',
    description: 'Review install posture (the support bundle carries the install facts)',
    usage: '[review]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'review';
      if (sub === 'review') {
        const profiles = requireProfileManager(ctx).list();
        const secretKeys = await requireSecretsManager(ctx).list();
        ctx.print(
          [
            'Install Review',
            `  version: ${VERSION}`,
            `  profiles: ${profiles.length}`,
            `  secret keys: ${secretKeys.length}`,
          ].join('\n'),
        );
        return;
      }
      ctx.print('Usage: /install [review]\n  The install facts for a support thread are in /setup support-bundle <dir> (platform-review.json).');
    },
  });

  registerUpdateCommand(registry);

  registry.register({
    name: 'auth',
    description: 'Review auth posture, and sign in to or out of a daemon or listener session',
    usage:
      '[review|show <provider>|repair <provider>|bundle export <path>|bundle inspect <path>|login <daemon|listener> <baseUrl> <username> [password] [secretKey]|logout <daemon|listener> <baseUrl> [secretKey]|local <review|panel|add-user|delete-user|rotate-password|revoke-session|clear-bootstrap-file>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      const subscriptions = requireSubscriptionManager(ctx);
      const serviceRegistry = requireServiceRegistry(ctx);
      const secretsManager = requireSecretsManager(ctx);
      if (sub === 'local') {
        handleLocalAuthCommand(args.slice(1), ctx);
        return;
      }
      if (await handleAuthReview(args, ctx, { serviceRegistry, subscriptionManager: subscriptions, secretsManager })) return;

      if (
        await handleAuthBundle(args, ctx, {
          secretsManager,
          subscriptions,
          resolvePath: (path) => shellPaths.resolveWorkspacePath(path),
          confirmed: true,
        })
      )
        return;

      if (sub === 'login') {
        const target = args[1];
        const username = args[3];
        const password = args[4];
        if ((target !== 'daemon' && target !== 'listener') || !args[2] || !username) {
          ctx.print('Usage: /auth login <daemon|listener> <baseUrl> <username> [password] [secretKey]  (omit the password to be asked for it with masked input)');
          return;
        }
        const baseUrl = serviceBaseUrl(ctx, args[2], 'Auth login');
        if (!baseUrl) return;
        const secretKey = sessionTokenKey(target, args[5]);
        const exchange = (secret: string): Promise<void> =>
          exchangeServiceLogin(ctx, { target, baseUrl, username, password: secret, secretKey });
        if (password) {
          ctx.print('Warning: a password typed on the command line stays visible on screen. Omit it to be asked with masked input.');
          await exchange(password);
          return;
        }
        if (!ctx.beginConcealedInput) {
          ctx.print('Masked input is unavailable on this surface; pass the password as the fifth argument.');
          return;
        }
        ctx.print(`Enter the ${target} password for ${username}: masked; Enter to sign in, Esc to cancel.`);
        ctx.beginConcealedInput({
          label: `${target} password`,
          onSubmit: async (value) => {
            if (value.length === 0) {
              ctx.print('Auth login cancelled: no password entered.');
              return;
            }
            await exchange(value);
          },
          onCancel: () => ctx.print('Auth login cancelled.'),
        });
        return;
      }

      if (sub === 'logout') {
        const target = args[1];
        if ((target !== 'daemon' && target !== 'listener') || !args[2]) {
          ctx.print('Usage: /auth logout <daemon|listener> <baseUrl> [secretKey]');
          return;
        }
        const baseUrl = serviceBaseUrl(ctx, args[2], 'Auth logout');
        if (!baseUrl) return;
        await endServiceSession(ctx, { target, baseUrl, secretKey: sessionTokenKey(target, args[3]) });
        return;
      }

      ctx.print(
        'Usage: /auth [review|show <provider>|bundle export <path>|bundle inspect <path>|login <daemon|listener> <baseUrl> <username> [password] [secretKey]|logout <daemon|listener> <baseUrl> [secretKey]|local <review|panel|add-user|delete-user|rotate-password|revoke-session|clear-bootstrap-file>]',
      );
    },
  });
}

const handleAuthReview = createAuthReviewHandler<CommandContext>({
  reportFailure: false,
  review: (snapshot, builtinProviders) => [
    'Auth Review',
    '  daemon login route: /login',
    '  listener login route: /login',
    `  stored secrets: ${snapshot.secretKeyCount}`,
    `  built-in providers: ${builtinProviders.length}${builtinProviders.length > 0 ? ` (${builtinProviders.join(', ')})` : ''}`,
    `  active subscriptions: ${snapshot.activeSubscriptions}${
      snapshot.activeSubscriptions > 0
        ? ` (${snapshot.providers
            .filter((provider) => provider.activeSubscription)
            .map((provider) => provider.provider)
            .join(', ')})`
        : ''
    }`,
    `  pending subscriptions: ${snapshot.pendingSubscriptions}${
      snapshot.pendingSubscriptions > 0
        ? ` (${snapshot.providers
            .filter((provider) => provider.pendingLogin)
            .map((provider) => provider.provider)
            .join(', ')})`
        : ''
    }`,
    ...snapshot.providers.map(
      (provider) =>
        `  ${provider.provider}  freshness=${provider.freshness}  mode=${provider.callbackMode}  configured=${provider.configured ? 'yes' : 'no'}`,
    ),
  ],
  show: (provider, inspection) => [
    `Auth Provider ${provider}`,
    `  configured: ${inspection.configured ? 'yes' : 'no'}`,
    ...(inspection.source ? [`  source: ${inspection.source}`] : []),
    `  freshness: ${inspection.freshness}`,
    `  callbackMode: ${inspection.callbackMode}`,
    ...(inspection.redirectUri ? [`  redirectUri: ${inspection.redirectUri}`] : []),
    ...(inspection.localCallback ? [`  localCallback: ${inspection.localCallback}`] : []),
    `  activeSubscription: ${inspection.activeSubscription ? 'yes' : 'no'}`,
    `  pendingLogin: ${inspection.pendingLogin ? 'yes' : 'no'}`,
    `  overrideAmbientApiKeys: ${inspection.overrideAmbientApiKeys ? 'yes' : 'no'}`,
    ...(inspection.tokenType ? [`  tokenType: ${inspection.tokenType}`] : []),
    ...(inspection.expiresAt ? [`  expiresAt: ${new Date(inspection.expiresAt).toISOString()}`] : []),
    ...inspection.issues.map((issue) => `  issue: ${issue}`),
    ...inspection.nextActions.map((action) => `  next: ${action}`),
  ],
  repair: (provider, inspection) => [
    `Auth Repair ${provider}`,
    `  configured: ${inspection.configured ? 'yes' : 'no'}`,
    `  freshness: ${inspection.freshness}`,
    `  callbackMode: ${inspection.callbackMode}`,
    ...inspection.issues.map((issue) => `  issue: ${issue}`),
    ...(inspection.nextActions.length > 0
      ? ['  next:', ...inspection.nextActions.map((action) => `    ${action}`)]
      : ['  No active repair actions suggested.']),
  ],
});

const handleAuthBundle = createAuthBundleHandler<CommandContext, AuthReviewBundle>({
  confirmExport: false,
  reportReadFailure: false,
  build: (base) => ({ ...base, daemonLoginUrl: 'http://127.0.0.1:3421/login', listenerLoginUrl: 'http://127.0.0.1:3422/login' }),
  inspect: (value) => inspectAuthBundle(value as AuthReviewBundle),
});
