import { createCliProviderViews } from '@goodvibes-jev/engine/terminal-shell/cli-provider-views';
export { buildSyntheticChainEntries, formatSyntheticChainText } from '@goodvibes-jev/engine/terminal-shell/cli-provider-views';
import type { RuntimeServices } from '../runtime/services.ts';
import 'node:fs';
import 'node:path';

import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/providers';
import '../config/secrets.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/providers';

import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { formatProviderAuthRoute } from './provider-auth-routes.ts';
import '../providers/provider-classification.ts';
import '@goodvibes-jev/engine/terminal-shell';
import '@goodvibes-jev/engine/terminal-shell';

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
  withRuntimeServices,
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

// This command runs in its own short-lived process. The running host (daemon or TUI) re-reads the user file at its next sign-in or session check, so a deleted user or changed password reaches its accounts, and ends that user's sessions, without a restart. Other sessions live in the host's memory and are never reachable from here.
const HOST_RESTART_NOTE = 'A running host picks this up at its next sign-in or session check (within a few seconds) and ends that user\'s sessions then; no restart is needed.';
const SESSIONS_NOT_REACHABLE = 'Sessions are held in memory by the running host and this command cannot reach them. Restart the host to end all of its sessions.';

interface AuthCommandResult {
  readonly output: string;
  readonly exitCode: number;
}

async function renderAuth(runtime: CliCommandRuntime): Promise<AuthCommandResult> {
  const ok = (output: string): AuthCommandResult => ({ output, exitCode: 0 });
  const notFound = (output: string): AuthCommandResult => ({ output, exitCode: 1 });
  const usage = (output: string): AuthCommandResult => ({ output, exitCode: 2 });
  return await withRuntimeServices(runtime, (services): AuthCommandResult => {
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
      return services.localUserAuthManager.revokeSession(token) ? ok('Auth session revoked.') : notFound(`No auth session found in this process. ${SESSIONS_NOT_REACHABLE}`);
    }
    if (sub === 'revoke-sessions') {
      const username = rest[0];
      if (!username) return usage('Usage: goodvibes auth revoke-sessions <username>');
      const count = services.localUserAuthManager.revokeSessionsForUser(username);
      return count > 0 ? ok(`Auth sessions revoked for ${username}: ${count}`) : notFound(`No auth sessions revoked for ${username} in this process. ${SESSIONS_NOT_REACHABLE}`);
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
    const value = {
      ...paths,
      users: snapshot.users.map((user) => ({ username: user.username, roles: user.roles })),
      sessions: snapshot.sessions.length,
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
        snapshot.sessions,
        [
          `GoodVibes auth sessions in this process (${snapshot.sessions.length}); a running host's sessions are not listed`,
          ...snapshot.sessions.map(
            (session) =>
              `  ${session.username} expires=${new Date(session.expiresAt).toISOString()} id=${session.id}`,
          ),
        ].join('\n'),
      ));
    }
    return ok(formatJsonOrText(runtime.cli)(
      value,
      [
        'GoodVibes auth',
        `  permission mode: ${String(value.permissionMode)}`,
        `  users: ${value.users.length}`,
        ...value.users.map((user) => `    ${user.username} (${user.roles.join(', ') || 'no roles'})`),
        `  sessions in this process: ${value.sessions} (a running host's sessions are not listed)`,
        `  user store: ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
        `  bootstrap credential: ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
        `  operator tokens: ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
      ].join('\n'),
    ));
  }, { modelData: 'skip' });
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
      case 'pair':
        console.log(await renderPairing(runtime));
        return { handled: true, exitCode: 0 };
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

const { renderProviders, renderModels } = createCliProviderViews<CliCommandRuntime, RuntimeServices>(withRuntimeServices, {
  surface: 'tui',
  enrichModelFamilies: true,
  syntheticCatalog: true,
  inlineReceipts: true,
  binary: () => 'goodvibes',
  formatProviderAuthRoute,
});
