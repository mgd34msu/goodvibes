import { revealOrNull } from '@goodvibes-jev/engine/platform/platform/security';
import { createAuthCommand } from '@goodvibes-jev/engine/terminal-shell/auth-review-command';
import type { ServiceSignIn, ServiceSignOut } from '@goodvibes-jev/engine/terminal-shell/provider-account-commands';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { buildUrl } from '@goodvibes-jev/engine/transport-http';
import { isLoopbackHost } from '@goodvibes-jev/engine/platform/platform/utils/reachable-base-url';
import { readDaemonSessionToken, writeDaemonSessionToken } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-credentials';
import { daemonTokenOverride, resolveControlPlaneBaseUrl } from '../../runtime/client/operator-endpoint.ts';
import { parseDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import { registerUpdateCommand } from './update-runtime.ts';
import '@/runtime/index.ts';
import {
  requireProfileManager,
  requireSecretsManager,
  requireShellPaths,
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
 * A listener session token as stored: with the origin that issued it, so it is
 * only ever presented back to that origin.
 */
interface StoredListenerSession {
  readonly origin: string;
  readonly token: string;
}

function encodeListenerSession(origin: string, token: string): string {
  return JSON.stringify({ origin, token } satisfies StoredListenerSession);
}

/** The stored listener session, or null when the value does not name the origin that issued it. */
function decodeListenerSession(value: string): StoredListenerSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredListenerSession> | null;
    return parsed && typeof parsed.origin === 'string' && typeof parsed.token === 'string' && parsed.token ? { origin: parsed.origin, token: parsed.token } : null;
  } catch {
    return null;
  }
}

/**
 * The service URL a password or session token may be sent to, or why not:
 * plain http carries them readable by anyone on the path, so it is accepted
 * only for this machine.
 */
function serviceBaseUrl(raw: string, action: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw commandRefusal(`${action}: "${raw}" is not a web address. Give the service's address, for example https://host.example:3421. Nothing was sent.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw commandRefusal(`${action}: ${url.protocol} is not a web address. Use https:// (or http:// for this machine). Nothing was sent.`);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw commandRefusal(`${action}: ${url.host} is another machine and http:// would send the credential unencrypted. Use https://${url.host}${url.pathname === '/' ? '' : url.pathname}. Nothing was sent.`);
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
      // A redirect is never followed: the password goes only to the address typed.
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_LOGIN_TIMEOUT_MS),
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get('location');
      let where = 'another address';
      try { if (location) where = new URL(location, url).origin; } catch { /* an unreadable Location names nothing */ }
      throw commandRefusal(`Not signed in: ${input.baseUrl.origin} answered with a redirect to ${where}, and the password is sent only to the address you typed. Sign in at that address directly if it is the ${input.target}. Nothing was stored.`);
    }
    if (!response.ok) {
      // The body is not echoed: a login endpoint may reflect the submitted credentials.
      throw commandRefusal(`Not signed in: the ${input.target} answered HTTP ${response.status}. Check the address, user name and password, then try again. Nothing was stored.`);
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== 'string') {
      throw commandRefusal(`Not signed in: the ${input.target}'s answer held no session. Nothing was stored.`);
    }
    if (input.target === 'daemon') {
      // The session is what this terminal presents to that daemon from now on
      // (operator-endpoint.ts), held per address beside its other bearers.
      writeDaemonSessionToken(requireShellPaths(ctx).homeDirectory, input.baseUrl.origin, body.token);
      // The session is read for the address this terminal dials, compared the way it is stored (one origin form).
      const signedIn = parseDaemonOrigin(input.baseUrl.origin)?.baseUrl ?? input.baseUrl.origin;
      const dialled = resolveControlPlaneBaseUrl(ctx.platform.configManager);
      const dialledOrigin = dialled ? parseDaemonOrigin(dialled)?.baseUrl ?? null : null;
      const notInUse = daemonTokenOverride()
        ? 'GOODVIBES_DAEMON_TOKEN is set, and it is the bearer for every daemon call while it is'
        : dialledOrigin !== signedIn
          ? `this terminal dials ${dialled ?? 'no daemon address'}, not ${signedIn}; the session is used once this terminal is pointed at that address (connect to it from /setup, Network step)`
          : null;
      ctx.print([
        notInUse
          ? `Signed in to the daemon at ${signedIn} as ${input.username}; the session is stored but not in use: ${notInUse}.`
          : `Signed in to the daemon at ${signedIn} as ${input.username}; this terminal now calls that daemon with the session.`,
        `  It stays ${notInUse ? 'stored' : 'in use'} until it expires (calls are then refused until you sign in again or sign out) or you run /accounts sign-out daemon ${signedIn}.`,
        ...(input.secretKey === sessionTokenKey(input.target, undefined) ? [] : [`  A daemon session is kept per daemon address, so the key name ${input.secretKey} is not used.`]),
      ].join('\n'));
      return;
    }
    // Stored with the origin that issued it: sign-out sends it back only there.
    await requireSecretsManager(ctx).set(input.secretKey, encodeListenerSession(input.baseUrl.origin, body.token));
    ctx.print([
      `Signed in to the ${input.target} at ${input.baseUrl.origin} as ${input.username}; the session token is in secure storage as ${input.secretKey}.`,
      `  The session stays valid on the ${input.target} until it expires or you run /accounts sign-out ${input.target} ${input.baseUrl.origin}${input.secretKey === sessionTokenKey(input.target, undefined) ? '' : ` --key ${input.secretKey}`}.`,
    ].join('\n'));
  } catch (error) {
    if (readRefusal(error)) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw commandRefusal(
      timedOut
        ? `Not signed in: no answer from ${input.baseUrl.origin} after ${AUTH_LOGIN_TIMEOUT_MS / 1000}s. Nothing was stored.`
        : `Not signed in: ${error instanceof Error ? error.message : String(error)}. Nothing was stored.`,
    );
  }
}

/**
 * Ends a service session: the daemon or listener ends it through its
 * `POST /logout` route, which needs no role (a session may always end itself)
 * and takes the token only in the Authorization header, never in the path, so
 * no request log or proxy in front of a remote daemon records it. The token is
 * removed from this terminal either way. An older build without the route
 * answers 404; its session lapses at its expiry or an admin revokes it.
 */
async function endServiceSession(
  ctx: CommandContext,
  input: { target: ServiceTarget; baseUrl: URL; secretKey: string },
): Promise<void> {
  const secrets = requireSecretsManager(ctx);
  const homeDirectory = requireShellPaths(ctx).homeDirectory;
  // A daemon session is held per address; a listener session names the origin that issued it.
  const stored = input.target === 'daemon' ? readDaemonSessionToken(homeDirectory, input.baseUrl.origin) : revealOrNull(await secrets.get(input.secretKey), 'dispatch');
  if (!stored) {
    throw commandRefusal(`No ${input.target} session is held for ${input.baseUrl.origin}; nothing to sign out of.`, `/accounts sign-in ${input.target} ${input.baseUrl.origin} signs in.`);
  }
  let token = stored;
  if (input.target === 'listener') {
    const session = decodeListenerSession(stored);
    if (!session) {
      // It does not say which listener issued it, so it is sent nowhere.
      await secrets.delete(input.secretKey);
      ctx.print(`Removed the stored listener token ${input.secretKey} from this terminal without contacting ${input.baseUrl.origin}: it does not name the listener that issued it, so it is never sent anywhere. That session lapses at its expiry.`);
      return;
    }
    if (session.origin !== input.baseUrl.origin) {
      throw commandRefusal(`The listener session stored as ${input.secretKey} was issued by ${session.origin}; it is never sent to ${input.baseUrl.origin}. Nothing was sent or removed.`, `/accounts sign-out listener ${session.origin}${input.secretKey === sessionTokenKey('listener', undefined) ? '' : ` --key ${input.secretKey}`} signs out there.`);
    }
    token = session.token;
  }
  let revoked: string;
  try {
    const response = await fetch(buildUrl(input.baseUrl.href, '/logout'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      // The token is sent to its issuing origin only, never on to a redirect target.
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_LOGIN_TIMEOUT_MS),
    });
    revoked = response.ok
      ? `The ${input.target} ended the session.`
      : response.status === 401
        ? `The ${input.target} no longer knows the session (it expired or was revoked already).`
        : response.status === 404 || response.status === 405
          ? `The ${input.target} is an older build without a sign-out route, so the session lapses at its expiry${input.target === 'daemon' ? ', or an administrator ends it with /local-auth sign-out' : ''}.`
          : `The ${input.target} did not end the session (HTTP ${response.status}); it lapses at its expiry${input.target === 'daemon' ? ', or an administrator ends it with /local-auth sign-out' : ''}.`;
  } catch (error) {
    revoked = `The ${input.target} could not be reached (${error instanceof Error ? error.message : String(error)}); the session lapses at its expiry.`;
  }
  if (input.target === 'daemon') {
    writeDaemonSessionToken(homeDirectory, input.baseUrl.origin, null);
    ctx.print(`Signed out of the daemon at ${input.baseUrl.origin}: ${revoked} This terminal calls it with its own credential again.`);
    return;
  }
  await secrets.delete(input.secretKey);
  ctx.print(`Signed out of the ${input.target} at ${input.baseUrl.origin}: ${revoked} The stored token ${input.secretKey} was removed.`);
}

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'login',
    description: 'Front-door login flow for provider subscriptions and local service sessions',
    usage: '[provider <name> start|finish <code>|service <daemon|listener> <baseUrl> <username> [password] [secretKey]]',
    // The service password and a provider sign-in code are never kept in the input history.
    secretArgs: {
      subcommands: { service: [4] },
      select: (args) => (args[0]?.toLowerCase() === 'provider' && args[2]?.toLowerCase() === 'finish' ? [3] : []),
    },
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
    secretArgs: { subcommands: { login: [4], 'local add-user': [3], 'local rotate-password': [3], 'local revoke-session': [2] } },
    confirm: (args, ctx) => authBundleExportConfirmation(args, (path) => requireShellPaths(ctx).resolveWorkspacePath(path)),
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
  reportReadFailure: false,
  build: (base) => ({ ...base, daemonLoginUrl: 'http://127.0.0.1:3421/login', listenerLoginUrl: 'http://127.0.0.1:3422/login' }),
  inspect: (value) => inspectAuthBundle(value as AuthReviewBundle),
});
