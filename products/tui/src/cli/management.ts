import { createCliProviderViews } from '@goodvibes/engine/terminal-shell/cli-provider-views';
export { buildSyntheticChainEntries, formatSyntheticChainText } from '@goodvibes/engine/terminal-shell/cli-provider-views';
import { UserAuthManager } from '@goodvibes/engine/platform/platform/security';
import { openAuthorityRecordFile } from '@goodvibes/engine/platform/platform/cluster';
import { dirname, join } from 'node:path';
import { deriveControlPlaneBaseUrl, readControlPlaneBinding } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/network/outbound';
import { resolveRemoteDaemonTarget, type DaemonFailure, type RemoteDaemonTarget } from '@goodvibes/engine/terminal-shell/cluster-remote-daemon-target';
import { callDaemonMethod, callDaemonRoute } from '@goodvibes/engine/terminal-shell/raw-reply-route';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';

import { summarizeError } from '@goodvibes/engine/platform/platform/utils';

import type { CliCommandRuntime } from '@goodvibes/engine/terminal-shell';
import { formatProviderAuthRoute } from './provider-auth-routes.ts';

import { handleServiceCommand } from './service-command.ts';
import { handleBundleCommand } from './bundle-command.ts';
import { handleHooksCommand } from './hooks-command.ts';
import { handlePluginCommand } from './plugin-command.ts';
import { buildListenerTestResult, formatListenerTestResult, handleSurfacesCommand } from './surface-command.ts';
import {
  buildControlPlaneStatusResult,
  formatControlPlaneStatus,
  runSecrets,
  handleSessions,
  handleTasks,
  renderPairing,
  renderRemote,
  renderSubscriptions,
  renderWeb,
} from './management-commands.ts';
import {
  yesNo,
  formatJsonOrText,
  hasCommandFlag,
  runNonInteractiveAgent,
  isPresentConfigValue,
  urlHostForBindHost,
  probeTcp,
  readAuthPaths,
  readOptionValues,
  commandValues,
  readPassword,
} from './management-utils.ts';

interface CliCommandResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

export {
  yesNo,
  formatJsonOrText,
  hasCommandFlag,
  isPresentConfigValue,
  getNestedValue,
  urlHostForBindHost,
  enableServicePosture,
  enableEndpointLanDefault,
  applyTargetEndpointFlagsOrDefault,
  openBrowser,
  probeTcp,
  withRuntimeServices,
  readAuthPaths,
  runNonInteractiveAgent,
} from './management-utils.ts';

/**
 * Build the synthetic chain entry list for `goodvibes models chain` output.
 * Pure transformation: accepts canonical model data and an optional lowercase filter key,
 * returns a serializable array suitable for both JSON and text formatting.
 *
 * @internal exported for unit testing
 */

// This command runs in its own short-lived process. The running daemon re-reads the user file at its next sign-in or session check, so a deleted user or changed password reaches its accounts, and ends that user's sessions, without a restart. Sign-in sessions live in the daemon's memory, so listing and revoking them is asked of the daemon on this machine, with its operator token.
const HOST_RESTART_NOTE = 'A running host picks this up at its next sign-in or session check (within a few seconds) and ends that user\'s sessions then; no restart is needed.';

interface DaemonAuthSession { readonly id: string; readonly username: string; readonly expiresAt: number }

/**
 * The daemon on this machine, the one serving sign-ins against this user store:
 * its loopback address from the control-plane settings, never a connected
 * remote daemon, and the operator token from this machine's daemon home.
 */
function localDaemonAuthTarget(runtime: CliCommandRuntime): { readonly ok: true; readonly target: RemoteDaemonTarget; readonly fetchImpl: typeof fetch } | DaemonFailure {
  const read = (key: string): unknown => runtime.configManager.get(key as never);
  const resolved = resolveRemoteDaemonTarget({
    flags: { host: deriveControlPlaneBaseUrl(readControlPlaneBinding(read), 'loopback') },
    configManager: runtime.configManager,
    daemonHomeDir: resolveGoodVibesDaemonHome(runtime.homeDirectory),
  });
  if (!resolved.ok) return resolved;
  return { ok: true, target: resolved.target, fetchImpl: createNetworkFetch(globalThis.fetch, runtime.configManager) };
}

async function listDaemonAuthSessions(runtime: CliCommandRuntime): Promise<{ readonly ok: true; readonly sessions: readonly DaemonAuthSession[] } | DaemonFailure> {
  const daemon = localDaemonAuthTarget(runtime);
  if (!daemon.ok) return daemon;
  const answer = await callDaemonRoute<{ readonly sessions?: readonly DaemonAuthSession[] }>(
    daemon.target, '/api/local-auth', { method: 'GET', envelope: 'raw' }, daemon.fetchImpl,
  );
  return answer.ok ? { ok: true, sessions: answer.data.sessions ?? [] } : sessionCallFailure(daemon.target, answer);
}

async function revokeDaemonAuthSession(runtime: CliCommandRuntime, sessionIdOrToken: string): Promise<{ readonly ok: true } | DaemonFailure> {
  const daemon = localDaemonAuthTarget(runtime);
  if (!daemon.ok) return daemon;
  const answer = await callDaemonMethod<{ readonly revoked?: boolean }>(
    daemon.target, 'local_auth.sessions.delete', { input: { sessionId: sessionIdOrToken } }, daemon.fetchImpl,
  );
  return answer.ok ? { ok: true } : sessionCallFailure(daemon.target, answer);
}

/**
 * A failed sign-in-session call in words that fit it: sessions live only in
 * the running daemon, so an unanswered call means that daemon is not running
 * or not reachable at its address, and nothing was changed. The shared
 * reader's wording is for cluster verbs.
 */
function sessionCallFailure(target: RemoteDaemonTarget, failure: DaemonFailure): DaemonFailure {
  if (failure.code !== 'unreachable') return failure;
  return {
    ...failure,
    error: `the daemon on this machine is not running or not reachable at ${target.baseUrl}, so no sign-in session was read or ended (its sessions end with it)`,
    fix: 'start it with goodvibes service start (or goodvibes-daemon serve), then run this again; goodvibes-daemon status shows the address it listens on',
  };
}

function daemonFailureText(failure: DaemonFailure): string {
  return `${failure.error}\n  ${failure.fix}`;
}

interface AuthCommandResult {
  readonly output: string;
  readonly exitCode: number;
}

async function renderAuth(runtime: CliCommandRuntime): Promise<AuthCommandResult> {
  const pending: UserAuthManager[] = [];
  try { return await renderAuthCommand(runtime, pending); }
  // A user change is written to the authority record before the command exits.
  finally { for (const manager of pending) await manager.settled(); }
}

async function renderAuthCommand(runtime: CliCommandRuntime, pending: UserAuthManager[]): Promise<AuthCommandResult> {
  const ok = (output: string): AuthCommandResult => ({ output, exitCode: 0 });
  const notFound = (output: string): AuthCommandResult => ({ output, exitCode: 1 });
  const usage = (output: string): AuthCommandResult => ({ output, exitCode: 2 });
  // The local user file and the setup credential are this user's own files: the
  // command opens them alone, not the whole runtime of the folder it was typed in.
  const authPaths = readAuthPaths(runtime);
  // The authority record beside the user file: a user changed here is the
  // daemon's and, in a group, every machine's (security/user-auth.ts).
  const authorityPath = join(dirname(authPaths.userStorePath), 'control-plane', 'authority-record.json');
  const services = {
    localUserAuthManager: new UserAuthManager({
      bootstrapFilePath: authPaths.userStorePath,
      bootstrapCredentialPath: authPaths.bootstrapCredentialPath,
      authority: openAuthorityRecordFile(authorityPath, () => runtime.configManager.getCategory('cluster')),
    }),
  };
  pending.push(services.localUserAuthManager);
  {
    const [sub = 'status', ...rawRest] = runtime.cli.commandArgs;
    const rest = commandValues(rawRest);
    if (sub === 'add-user' || sub === 'add') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]');
      const password = readPassword(rawRest);
      if (!password) return usage('Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]');
      const roles = readOptionValues(rawRest, '--role').filter((role) => role.length > 0);
      const user = services.localUserAuthManager.addUser(username, password, roles.length > 0 ? roles : ['user']);
      return ok(`Auth user added: ${user.username} (${user.roles.join(', ') || 'no roles'})`);
    }
    if (sub === 'delete-user' || sub === 'remove-user') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth delete-user <username>');
      return services.localUserAuthManager.deleteUser(username) ? ok(`Auth user deleted: ${username}\n${HOST_RESTART_NOTE}`) : notFound(`No auth user found: ${username}`);
    }
    if (sub === 'rotate-password' || sub === 'passwd') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]');
      const password = readPassword(rawRest);
      if (!password) return usage('Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]');
      services.localUserAuthManager.rotatePassword(username, password);
      return ok(`Auth password rotated: ${username}\n${HOST_RESTART_NOTE}`);
    }
    if (sub === 'revoke-session') {
      const token = rest[0];
      if (!token) return usage('Usage: goodvibes auth revoke-session <session-id-or-token>');
      const revoked = await revokeDaemonAuthSession(runtime, token);
      return revoked.ok ? ok('Auth session revoked on the running daemon.') : notFound(daemonFailureText(revoked));
    }
    if (sub === 'revoke-sessions') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth revoke-sessions <username>');
      const listed = await listDaemonAuthSessions(runtime);
      if (!listed.ok) return notFound(daemonFailureText(listed));
      const owned = listed.sessions.filter((session) => session.username === username);
      let count = 0;
      for (const session of owned) {
        const revoked = await revokeDaemonAuthSession(runtime, session.id);
        // A session that ended between the list and the revoke is gone either way.
        if (revoked.ok || revoked.code === 'refused') count += 1;
        else return notFound(`Auth sessions revoked for ${username} before the daemon stopped answering: ${count} of ${owned.length}\n${daemonFailureText(revoked)}`);
      }
      return count > 0 ? ok(`Auth sessions revoked for ${username} on the running daemon: ${count}`) : notFound(`The running daemon holds no auth sessions for ${username}.`);
    }
    if (sub === 'clear-bootstrap') {
      return ok(services.localUserAuthManager.clearBootstrapCredentialFile()
        ? 'Bootstrap credential file removed.'
        : 'Bootstrap credential file was already absent.');
    }
    if (sub !== 'status' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
      return usage('Usage: goodvibes auth [status|users|sessions|add-user|delete-user|rotate-password|revoke-session|revoke-sessions|clear-bootstrap]');
    }
    const snapshot = services.localUserAuthManager.inspect();
    const paths = readAuthPaths(runtime);
    // The sessions are the running daemon's; one loopback request, and only for the forms that show them.
    const daemonSessions = sub === 'users' ? null : await listDaemonAuthSessions(runtime);
    const sessionLines = daemonSessions === null ? []
      : daemonSessions.ok
        ? daemonSessions.sessions.map((session) => `  ${session.username} expires=${new Date(session.expiresAt).toISOString()} id=${session.id}`)
        : [];
    const sessionsUnavailable = daemonSessions !== null && !daemonSessions.ok ? `not read: ${daemonSessions.error}` : undefined;
    const value = {
      ...paths,
      users: snapshot.users.map((user) => ({ username: user.username, roles: user.roles })),
      sessions: daemonSessions?.ok ? daemonSessions.sessions.length : null,
      ...(sessionsUnavailable !== undefined ? { sessionsUnavailable } : {}),
      permissionMode: runtime.configManager.get('permissions.mode'),
    };
    if (sub === 'users') {
      return ok(formatJsonOrText(runtime.cli)(
        value.users,
        [
          `GoodVibes auth users (${value.users.length})`,
          ...value.users.map((user) => `  ${user.username} (${user.roles.join(', ') || 'no roles'})`),
        ].join('\n'),
      ));
    }
    if (sub === 'sessions') {
      if (daemonSessions === null || !daemonSessions.ok) return notFound(daemonSessions === null ? '' : daemonFailureText(daemonSessions));
      return ok(formatJsonOrText(runtime.cli)(
        daemonSessions.sessions,
        [`GoodVibes auth sessions on the running daemon (${daemonSessions.sessions.length})`, ...sessionLines].join('\n'),
      ));
    }
    return ok(formatJsonOrText(runtime.cli)(
      value,
      [
        'GoodVibes auth',
        `  permission mode: ${String(value.permissionMode)}`,
        `  users: ${value.users.length}`,
        ...value.users.map((user) => `    ${user.username} (${user.roles.join(', ') || 'no roles'})`),
        `  sessions on the running daemon: ${value.sessions ?? sessionsUnavailable}`,
        `  user store: ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
        `  bootstrap credential: ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
        `  operator tokens: ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
      ].join('\n'),
    ));
  }
}

export async function handleGoodVibesCliCommand(runtime: CliCommandRuntime): Promise<CliCommandResult> {
  try {
    switch (runtime.cli.command) {
      case 'run':
        return { handled: true, exitCode: await runNonInteractiveAgent(runtime) };
      case 'web':
        console.log(renderWeb(runtime));
        return { handled: true, exitCode: 0 };
      case 'service': {
        const result = await handleServiceCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'providers': {
        const result = await renderProviders(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'models': {
        const result = await renderModels(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'auth': {
        const result = await renderAuth(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'subscription': {
        const result = await renderSubscriptions(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'secrets': {
        const result = await runSecrets(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'sessions': {
        const result = await handleSessions(runtime);
        if (result === null) return { handled: false, exitCode: 0 };
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'tasks': {
        const result = await handleTasks(runtime);
        if (result.output) console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'surfaces': {
        const result = await handleSurfacesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'listener': {
        const result = await buildListenerTestResult(runtime);
        console.log(formatListenerTestResult(runtime, result));
        return { handled: true, exitCode: result.issues.length > 0 ? 1 : 0 };
      }
      case 'control-plane': {
        const result = await buildControlPlaneStatusResult(runtime);
        console.log(formatControlPlaneStatus(runtime, result));
        return { handled: true, exitCode: result.issues.length > 0 ? 1 : 0 };
      }
      case 'pair': {
        const result = await renderPairing(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'support-bundle': {
        const result = await handleBundleCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'hooks': {
        const result = await handleHooksCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'plugin': {
        const result = await handlePluginCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'remote':
        console.log(await renderRemote(runtime, 'remote'));
        return { handled: true, exitCode: 0 };
      case 'bridge':
        console.log(await renderRemote(runtime, 'bridge'));
        return { handled: true, exitCode: 0 };
      default:
        return { handled: false, exitCode: 0 };
    }
  } catch (error) {
    console.error(summarizeError(error));
    return { handled: true, exitCode: 1 };
  }
}

const { renderProviders, renderModels } = createCliProviderViews<CliCommandRuntime, OneShotProviderServices>(withProviderServices, {
  surface: 'tui',
  enrichModelFamilies: true,
  syntheticCatalog: true,
  inlineReceipts: true,
  binary: () => 'goodvibes',
  formatProviderAuthRoute,
});
