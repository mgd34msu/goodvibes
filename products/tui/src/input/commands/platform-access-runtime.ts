import { revealOrNull } from '@goodvibes/engine/platform/platform/security';
import type { ServiceSessionRequest } from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { readRefusal } from '@goodvibes/engine/errors';
import { buildUrl } from '@goodvibes/engine/transport-http';
import { isLoopbackHost } from '@goodvibes/engine/platform/platform/utils/reachable-base-url';
import { readDaemonSessionToken, writeDaemonSessionToken } from '@goodvibes/engine/platform/platform/runtime/client/daemon-credentials';
import { daemonTokenOverride, resolveControlPlaneBaseUrl } from '../../runtime/client/operator-endpoint.ts';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerUpdateCommand } from './update-runtime.ts';
import {
  requireSecretsManager,
  requireShellPaths,
} from './runtime-services.ts';

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
): Promise<string> {
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
          ? `this terminal dials ${dialled ?? 'no daemon address'}, not ${signedIn}; the session is used once this terminal is pointed at that address (Settings, the daemon to connect to)`
          : null;
      return [
        notInUse
          ? `Signed in to the daemon at ${signedIn} as ${input.username}; the session is stored but not in use: ${notInUse}.`
          : `Signed in to the daemon at ${signedIn} as ${input.username}; this terminal now calls that daemon with the session.`,
        `  It stays ${notInUse ? 'stored' : 'in use'} until it expires (calls are then refused until you sign in again or sign out) or you sign out of it in Models and providers.`,
        ...(input.secretKey === sessionTokenKey(input.target, undefined) ? [] : [`  A daemon session is kept per daemon address, so the key name ${input.secretKey} is not used.`]),
      ].join('\n');
    }
    // Stored with the origin that issued it: sign-out sends it back only there.
    await requireSecretsManager(ctx).set(input.secretKey, encodeListenerSession(input.baseUrl.origin, body.token));
    return [
      `Signed in to the ${input.target} at ${input.baseUrl.origin} as ${input.username}; the session token is in secure storage as ${input.secretKey}.`,
      `  The session stays valid on the ${input.target} until it expires or you sign out of it in Models and providers.`,
    ].join('\n');
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
): Promise<string> {
  const secrets = requireSecretsManager(ctx);
  const homeDirectory = requireShellPaths(ctx).homeDirectory;
  // A daemon session is held per address; a listener session names the origin that issued it.
  const stored = input.target === 'daemon' ? readDaemonSessionToken(homeDirectory, input.baseUrl.origin) : revealOrNull(await secrets.get(input.secretKey), 'dispatch');
  if (!stored) {
    throw commandRefusal(`No ${input.target} session is held for ${input.baseUrl.origin}; nothing to sign out of.`, `Sign in to the ${input.target} at ${input.baseUrl.origin} in Models and providers.`);
  }
  let token = stored;
  if (input.target === 'listener') {
    const session = decodeListenerSession(stored);
    if (!session) {
      // It does not say which listener issued it, so it is sent nowhere.
      await secrets.delete(input.secretKey);
      return `Removed the stored listener token ${input.secretKey} from this terminal without contacting ${input.baseUrl.origin}: it does not name the listener that issued it, so it is never sent anywhere. That session lapses at its expiry.`;
    }
    if (session.origin !== input.baseUrl.origin) {
      throw commandRefusal(`The listener session stored as ${input.secretKey} was issued by ${session.origin}; it is never sent to ${input.baseUrl.origin}. Nothing was sent or removed.`, `Sign out of the listener at ${session.origin} instead.`);
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
          ? `The ${input.target} is an older build without a sign-out route, so the session lapses at its expiry${input.target === 'daemon' ? ', or an administrator ends it' : ''}.`
          : `The ${input.target} did not end the session (HTTP ${response.status}); it lapses at its expiry${input.target === 'daemon' ? ', or an administrator ends it' : ''}.`;
  } catch (error) {
    revoked = `The ${input.target} could not be reached (${error instanceof Error ? error.message : String(error)}); the session lapses at its expiry.`;
  }
  if (input.target === 'daemon') {
    writeDaemonSessionToken(homeDirectory, input.baseUrl.origin, null);
    return `Signed out of the daemon at ${input.baseUrl.origin}: ${revoked} This terminal calls it with its own credential again.`;
  }
  await secrets.delete(input.secretKey);
  return `Signed out of the ${input.target} at ${input.baseUrl.origin}: ${revoked} The stored token ${input.secretKey} was removed.`;
}

/**
 * This terminal app's own sessions toward a daemon or listener, as the
 * capabilities accounts.sign-in and accounts.sign-out take them
 * (capabilities/builtin/service-sessions.ts): the password goes only to the
 * address given.
 */
export function serviceSessionsOf(ctx: CommandContext) {
  return {
    async signIn(input: ServiceSessionRequest): Promise<string> {
      const baseUrl = serviceBaseUrl(input.address, 'Not signed in');
      if (!input.password) throw commandRefusal('Not signed in: no password was given.');
      return exchangeServiceLogin(ctx, { target: input.service, baseUrl, username: input.user, password: input.password, secretKey: sessionTokenKey(input.service, input.key || undefined) });
    },
    async signOut(input: Omit<ServiceSessionRequest, 'user' | 'password'>): Promise<string> {
      const baseUrl = serviceBaseUrl(input.address, 'Not signed out');
      return endServiceSession(ctx, { target: input.service, baseUrl, secretKey: sessionTokenKey(input.service, input.key || undefined) });
    },
  };
}

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registerUpdateCommand(registry);
}
