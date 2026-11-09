import { createCliProviderViews } from '@goodvibes-jev/engine/terminal-shell/cli-provider-views';
export { buildSyntheticChainEntries } from '@goodvibes-jev/engine/terminal-shell/cli-provider-views';
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
  handleSecrets,
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
  exitCodeForText,
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
  extractAuthorizationCode,
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

async function renderAuth(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, (services) => {
    const [sub = 'status', ...rawRest] = runtime.cli.commandArgs;
    const rest = commandValues(rawRest);
    if (sub === 'add-user' || sub === 'add') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]';
      const password = readPassword(rawRest);
      if (!password) return 'Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]';
      const roles = readOptionValues(rawRest, '--role').filter((role) => role.length > 0);
      const user = services.localUserAuthManager.addUser(username, password, roles.length > 0 ? roles : ['user']);
      return `Auth user added: ${user.username} (${user.roles.join(', ') || 'no roles'})`;
    }
    if (sub === 'delete-user' || sub === 'remove-user') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth delete-user <username>';
      return services.localUserAuthManager.deleteUser(username) ? `Auth user deleted: ${username}` : `No auth user found: ${username}`;
    }
    if (sub === 'rotate-password' || sub === 'passwd') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]';
      const password = readPassword(rawRest);
      if (!password) return 'Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]';
      services.localUserAuthManager.rotatePassword(username, password);
      return `Auth password rotated: ${username}`;
    }
    if (sub === 'revoke-session') {
      const token = rest[0];
      if (!token) return 'Usage: goodvibes auth revoke-session <session-id-or-token>';
      return services.localUserAuthManager.revokeSession(token) ? 'Auth session revoked.' : 'No auth session found.';
    }
    if (sub === 'revoke-sessions') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth revoke-sessions <username>';
      const count = services.localUserAuthManager.revokeSessionsForUser(username);
      return `Auth sessions revoked for ${username}: ${count}`;
    }
    if (sub === 'clear-bootstrap') {
      return services.localUserAuthManager.clearBootstrapCredentialFile()
        ? 'Bootstrap credential file removed.'
        : 'Bootstrap credential file was already absent.';
    }
    if (sub !== 'status' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
      return 'Usage: goodvibes auth [status|users|sessions|add-user|delete-user|rotate-password|revoke-session|revoke-sessions|clear-bootstrap]';
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
      return formatJsonOrText(runtime.cli)(
        value.users,
        [
          `GoodVibes auth users (${value.users.length})`,
          ...value.users.map((user) => `  ${user.username} (${user.roles.join(', ') || 'no roles'})`),
        ].join('\n'),
      );
    }
    if (sub === 'sessions') {
      return formatJsonOrText(runtime.cli)(
        snapshot.sessions,
        [
          `GoodVibes auth sessions (${snapshot.sessions.length})`,
          ...snapshot.sessions.map(
            (session) =>
              `  ${session.username} expires=${new Date(session.expiresAt).toISOString()} id=${session.id}`,
          ),
        ].join('\n'),
      );
    }
    return formatJsonOrText(runtime.cli)(
      value,
      [
        'GoodVibes auth',
        `  permission mode: ${String(value.permissionMode)}`,
        `  users: ${value.users.length}`,
        ...value.users.map((user) => `    ${user.username} (${user.roles.join(', ') || 'no roles'})`),
        `  sessions: ${value.sessions}`,
        `  user store: ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
        `  bootstrap credential: ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
        `  operator tokens: ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
      ].join('\n'),
    );
  });
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
        const output = await renderProviders(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'models': {
        const output = await renderModels(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'auth': {
        const output = await renderAuth(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'subscription': {
        const output = await renderSubscriptions(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'secrets': {
        const output = await handleSecrets(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'sessions': {
        const output = await handleSessions(runtime);
        if (output === null) return { handled: false, exitCode: 0 };
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'tasks': {
        const output = await handleTasks(runtime);
        if (output) console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
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
