import { createCliProviderViews } from '@goodvibes/engine/terminal-shell/cli-provider-views';
export { buildSyntheticChainEntries, formatSyntheticChainText } from '@goodvibes/engine/terminal-shell/cli-provider-views';
import { autostartInstalledDaemon, createDaemonServiceControl } from '@goodvibes/engine/platform/platform/runtime/client';
import { deriveControlPlaneBaseUrl, readControlPlaneBinding } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { createNetworkFetch } from '@goodvibes/engine/platform/platform/runtime/network/outbound';
import { resolveRemoteDaemonTarget, type DaemonFailure, type RemoteDaemonTarget } from '@goodvibes/engine/terminal-shell/cluster-remote-daemon-target';
import { callDaemonMethod } from '@goodvibes/engine/terminal-shell/raw-reply-route';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';
import { daemonTargetInvoke, runCapabilityCommand } from '@goodvibes/engine/terminal-shell/capability-cli';

import { summarizeError } from '@goodvibes/engine/platform/platform/utils';

import type { CliCommandRuntime } from '@goodvibes/engine/terminal-shell';
import { formatProviderAuthRoute } from './provider-auth-routes.ts';

import { handleServiceCommand } from './service-command.ts';
import { daemonStartingInvoke, runSupportBundleCommand } from '@goodvibes/engine/terminal-shell/support-bundle-cli';
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

// Who may sign in is the daemon's: `goodvibes auth` asks the daemon on this machine through its local sign-in methods
// (`local_auth.*`), with its operator token, and never writes the user file itself.
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

/** One local sign-in method of the daemon on this machine, a write sent as the person's own request. */
async function callLocalAuth<T>(runtime: CliCommandRuntime, methodId: string, input: Record<string, unknown>, write: boolean): Promise<{ readonly ok: true; readonly data: T } | DaemonFailure> {
  const daemon = localDaemonAuthTarget(runtime);
  if (!daemon.ok) return daemon;
  const fetchImpl: typeof fetch = write
    ? ((url, init) => daemon.fetchImpl(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-goodvibes-explicit-user-request': 'true' } })) as typeof fetch
    : daemon.fetchImpl;
  const answer = await callDaemonMethod<T>(daemon.target, methodId, { input, ...(write ? {} : { readOnly: true }) }, fetchImpl);
  // Who may sign in is the user's own act: this typed command carries the machine's token, which is the user, so the daemon
  // runs it at once in every permission mode and asks nothing.
  return answer.ok ? { ok: true, data: answer.data } : signInCallFailure(daemon.target, answer);
}

/**
 * A failed call in words that fit it: who may sign in and their sessions are the daemon's, so an unanswered call
 * means the daemon on this machine is not running (and could not be started) or not reachable, and nothing changed.
 */
function signInCallFailure(target: RemoteDaemonTarget, failure: DaemonFailure): DaemonFailure {
  if (failure.code !== 'unreachable') return failure;
  return {
    ...failure,
    error: `the daemon on this machine is not running or not reachable at ${target.baseUrl}, so nothing was read or changed: who may sign in is the daemon's`,
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

/** One local sign-in method of the daemon on this machine; a write goes as the person's own request. */
type AuthCall = <T>(methodId: string, input: Record<string, unknown>, write: boolean) => Promise<{ readonly ok: true; readonly data: T } | DaemonFailure>;

/**
 * The daemon's local sign-in methods (`local_auth.*`), as `goodvibes auth` calls them. Who may sign in is the
 * daemon's: this command never writes the user file itself. A daemon that is installed and stopped is started once
 * and waited for, as the terminal programs do at start (runtime/client/daemon-autostart.ts); one that cannot be
 * reached then says so, and nothing is changed.
 */
function localAuthCaller(runtime: CliCommandRuntime): AuthCall {
  let started = false;
  const call = async <T>(methodId: string, input: Record<string, unknown>, write: boolean): Promise<{ readonly ok: true; readonly data: T } | DaemonFailure> => {
    const answer = await callLocalAuth<T>(runtime, methodId, input, write);
    if (answer.ok || answer.code !== 'unreachable' || started) return answer;
    started = true;
    const control = createDaemonServiceControl({ configManager: runtime.configManager, workingDirectory: runtime.workingDirectory });
    const outcome = await autostartInstalledDaemon({
      daemonMode: 'unavailable', control,
      isReachable: async () => (await callLocalAuth(runtime, 'local_auth.status', {}, false)).ok,
    });
    if (outcome.action !== 'started' && outcome.action !== 'came-online' && outcome.action !== 'program-started') return answer;
    return callLocalAuth<T>(runtime, methodId, input, write);
  };
  return call;
}

interface LocalAuthStatus {
  readonly users?: readonly { readonly username: string; readonly roles?: readonly string[] }[];
  readonly sessions?: readonly DaemonAuthSession[];
}

async function renderAuth(runtime: CliCommandRuntime): Promise<AuthCommandResult> {
  const ok = (output: string): AuthCommandResult => ({ output, exitCode: 0 });
  // A sign-in change the daemon did not make exits 1 (`do` never exits 3: it is not held, docs/exit-codes.md); a daemon that
  // still answers that it put the change to the owner exits 3.
  const notFound = (output: string): AuthCommandResult => ({ output, exitCode: /Answer it in Waiting for you/.test(output) ? 3 : 1 });
  const usage = (output: string): AuthCommandResult => ({ output, exitCode: 2 });
  const call = localAuthCaller(runtime);
  {
    const [sub = 'status', ...rawRest] = runtime.cli.commandArgs;
    const rest = commandValues(rawRest);
    if (sub === 'add-user' || sub === 'add') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]');
      const password = readPassword(rawRest);
      if (!password) return usage('Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]');
      const roles = readOptionValues(rawRest, '--role').filter((role) => role.length > 0);
      const added = await call('local_auth.users.create', { username, password, roles: roles.length > 0 ? roles : ['user'] }, true);
      return added.ok ? ok(`Auth user added: ${username} (${(roles.length > 0 ? roles : ['user']).join(', ')})`) : notFound(daemonFailureText(added));
    }
    if (sub === 'delete-user' || sub === 'remove-user') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth delete-user <username>');
      const deleted = await call<{ readonly deleted?: boolean }>('local_auth.users.delete', { username }, true);
      if (!deleted.ok) return notFound(daemonFailureText(deleted));
      return deleted.data?.deleted === false ? notFound(`No auth user found: ${username}`) : ok(`Auth user deleted: ${username}; their sign-in sessions ended with it.`);
    }
    if (sub === 'rotate-password' || sub === 'passwd') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]');
      const password = readPassword(rawRest);
      if (!password) return usage('Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]');
      const rotated = await call('local_auth.users.password.rotate', { username, password }, true);
      return rotated.ok ? ok(`Auth password rotated: ${username}`) : notFound(daemonFailureText(rotated));
    }
    if (sub === 'revoke-session') {
      const token = rest[0];
      if (!token) return usage('Usage: goodvibes auth revoke-session <session-id-or-token>');
      const revoked = await call('local_auth.sessions.delete', { sessionId: token }, true);
      return revoked.ok ? ok('Auth session revoked on the running daemon.') : notFound(daemonFailureText(revoked));
    }
    if (sub === 'revoke-sessions') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth revoke-sessions <username>');
      const listed = await call<LocalAuthStatus>('local_auth.status', {}, false);
      if (!listed.ok) return notFound(daemonFailureText(listed));
      const owned = (listed.data?.sessions ?? []).filter((session) => session.username === username);
      let count = 0;
      for (const session of owned) {
        const revoked = await call('local_auth.sessions.delete', { sessionId: session.id }, true);
        // A session that ended between the list and the revoke is gone either way.
        if (revoked.ok || revoked.code === 'refused') count += 1;
        else return notFound(`Auth sessions revoked for ${username} before the daemon stopped answering: ${count} of ${owned.length}\n${daemonFailureText(revoked)}`);
      }
      return count > 0 ? ok(`Auth sessions revoked for ${username} on the running daemon: ${count}`) : notFound(`The running daemon holds no auth sessions for ${username}.`);
    }
    if (sub === 'clear-bootstrap') {
      const cleared = await call<{ readonly removed?: boolean }>('local_auth.bootstrap.delete', {}, true);
      if (!cleared.ok) return notFound(daemonFailureText(cleared));
      return ok(cleared.data?.removed === false ? 'Bootstrap credential file was already absent.' : 'Bootstrap credential file removed.');
    }
    if (sub !== 'status' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
      return usage('Usage: goodvibes auth [status|users|sessions|add-user|delete-user|rotate-password|revoke-session|revoke-sessions|clear-bootstrap]');
    }
    const paths = readAuthPaths(runtime);
    // Users and sessions are the daemon's: one request answers both.
    const status = await call<LocalAuthStatus>('local_auth.status', {}, false);
    if (!status.ok) return notFound(daemonFailureText(status));
    const daemonSessions = { ok: true as const, sessions: status.data?.sessions ?? [] };
    const sessionLines = daemonSessions.sessions.map((session) => `  ${session.username} expires=${new Date(session.expiresAt).toISOString()} id=${session.id}`);
    const value = {
      ...paths,
      users: (status.data?.users ?? []).map((user) => ({ username: user.username, roles: [...(user.roles ?? [])] })),
      sessions: daemonSessions.sessions.length,
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
        `  sessions on the running daemon: ${value.sessions}`,
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
      // A capability by id, and the capabilities that serve a need: the daemon's capabilities.run and capabilities.find.
      case 'do':
      case 'find':
        return { handled: true, exitCode: await runCapabilityCommand({
          program: 'goodvibes', verb: runtime.cli.command, args: runtime.cli.commandArgs, json: runtime.cli.flags.outputFormat === 'json', caller: 'tui',
          // The daemon on this machine is started first when it is stopped, as the programs and the bundle forms do.
          invoke: daemonStartingInvoke(daemonTargetInvoke(runtime), runtime), workingDirectory: runtime.workingDirectory,
        }) };
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
      // The support bundle is the daemon's: bundle.export, bundle.inspect and bundle.import, as `do` runs them.
      case 'support-bundle':
        return { handled: true, exitCode: await runSupportBundleCommand({
          binary: 'goodvibes', command: 'support-bundle', caller: 'tui', args: runtime.cli.commandArgs,
          json: runtime.cli.flags.outputFormat === 'json', yes: runtime.cli.flags.yes === true,
          invoke: daemonTargetInvoke(runtime), configManager: runtime.configManager, workingDirectory: runtime.workingDirectory,
        }) };
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
