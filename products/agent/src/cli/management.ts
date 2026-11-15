import { commandTextExitCode } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { yesNo, formatJsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
export { yesNo, formatJsonOrText } from '@goodvibes-jev/engine/terminal-shell/cli-output';
import { createCliProviderViews } from '@goodvibes-jev/engine/terminal-shell/cli-provider-views';
import { openBrowser } from '@goodvibes-jev/engine/terminal-shell/cli-environment';
import { stableUrlHostForBindHost } from '@goodvibes-jev/engine/platform/platform/pairing';
export { openBrowser } from '@goodvibes-jev/engine/terminal-shell/cli-environment';
import { hasCommandFlag, isPresentConfigValue, extractAuthorizationCode } from '@goodvibes-jev/engine/terminal-shell/cli-arguments';
export { hasCommandFlag, isPresentConfigValue, extractAuthorizationCode } from '@goodvibes-jev/engine/terminal-shell/cli-arguments';
import { probeTcp as probe } from '@goodvibes-jev/engine/terminal-shell/service-io';
import { resolveConnectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { runSetupPairingCommand } from './setup-pair-command.ts';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import 'node:child_process';
import 'node:os';
import type { ConfigManager } from '../config/index.ts';
import '../config/index.ts';
import '../config/provider-model.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import '../config/secrets.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';
import '@goodvibes-jev/engine/platform/platform/providers';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/config';
import '@/runtime/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';
import { formatProviderAuthRoute } from './provider-auth-routes.ts';
import './provider-classification.ts';
import { handleBundleCommand } from './bundle-command.ts';
import { handleImportCommand } from './import-command.ts';
import { handleSecrets, handleSessions, handleTasks, renderPairing, renderSubscriptions, taskSubmitRefusal } from './management-commands.ts';
import {
  handleAgentKnowledgeCommand,
  handleAgentKnowledgeShortcutCommand,
  handleCompatCommand,
  handleDelegateCommand,
} from './agent-knowledge-command.ts';
import { handlePersonasCommand } from './personas-command.ts';
import { handleSkillsCommand } from './skills-command.ts';
import { handleMemoryCommand } from './memory-command.ts';
import { handleProfilesCommand } from './profiles-command.ts';
import { handleRoutinesCommand } from './routines-command.ts';
import { handleCiCommand } from './ci-command.ts';
import { handlePrincipalsCommand } from './principals-command.ts';
import { handleOwnerProfileCommand } from './owner-profile-command.ts';
import { handleChannelProfilesCommand } from './channel-profiles-command.ts';
import { handleWorkspacesCommand } from './workspaces-command.ts';
import { handleBrowserCommand } from './browser-command.ts';
import { handleRelayCommand } from './relay-command.ts';
import { handleFleetCommand } from './fleet-command.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';
import { dialHostForConfiguredHost } from '../config/connected-host-dial.ts';

export interface CliCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

interface CliCommandResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

function exitCodeForText(output: string): number {
  return commandTextExitCode(output, ['Usage:', 'Invalid ', 'Unsupported'], ['Session not found', 'Unknown task', 'Task submit failed ']);
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = Reflect.get(cursor, part);
  }
  return cursor;
}

/**
 * Where THIS process dials. Shares the wildcard→loopback mapping with every
 * other dial site (config/connected-host-dial.ts).
 */
const connectHostForBindHost = dialHostForConfiguredHost;

/**
 * Where ANOTHER machine dials, a pairing QR code, a phone-facing link: the
 * engine's stable-host rule, the same one the daemon and the TUI print. A
 * wildcard resolves away from loopback, because loopback on the other device
 * is the other device. Deliberately not the function above.
 */
export function urlHostForBindHost(host: string): string {
  return stableUrlHostForBindHost(host).host;
}

export function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return probe(host, port, timeoutMs, connectHostForBindHost);
}

export function readAuthPaths(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorToken = readConnectedHostOperatorToken(runtime.homeDirectory, resolveConnectedHostBaseUrl(runtime.configManager));
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath: operatorToken.path,
    operatorTokenPresent: operatorToken.present && Boolean(operatorToken.token),
  };
}

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  return runNativeHeadlessCommand(runtime);
}

async function renderAuth(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'status'] = runtime.cli.commandArgs;
  const blocked = new Set([
    'add-user',
    'add',
    'delete-user',
    'remove-user',
    'rotate-password',
    'passwd',
    'revoke-session',
    'revoke-sessions',
    'clear-bootstrap',
  ]);
  if (blocked.has(sub)) {
    return [
      'Unsupported: connected-host auth user/session administration is outside GoodVibes Agent.',
      'GoodVibes Agent does not create, delete, rotate, revoke, or clear connected-host users, sessions, or bootstrap credentials.',
      'Use the owning GoodVibes host for auth administration.',
    ].join('\n');
  }
  if (sub !== 'status' && sub !== 'review' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
    return 'Usage: goodvibes-agent auth [status|review|users|sessions]';
  }
  const paths = readAuthPaths(runtime);
  const value = {
    authOwner: 'external-runtime',
    operatorTokenPresent: paths.operatorTokenPresent,
    operatorTokenPath: paths.operatorTokenPath,
    compatibilityUserStorePresent: paths.userStorePresent,
    compatibilityUserStorePath: paths.userStorePath,
    compatibilityBootstrapCredentialPresent: paths.bootstrapCredentialPresent,
    compatibilityBootstrapCredentialPath: paths.bootstrapCredentialPath,
    permissionMode: runtime.configManager.get('permissions.mode'),
  };
  if (sub === 'users' || sub === 'sessions') {
    return formatJsonOrText(runtime.cli)(
      value,
      [
        `GoodVibes Agent auth ${sub}`,
        '  owner connected GoodVibes host',
        `  operator token ${paths.operatorTokenPresent ? 'present' : 'missing'}`,
        `  operator token path ${paths.operatorTokenPath}`,
        `  ${sub} managed outside Agent`,
        '  Agent does not enumerate or mutate connected-host users/sessions from the local CLI.',
      ].join('\n'),
    );
  }
  return formatJsonOrText(runtime.cli)(
    value,
    [
      'GoodVibes Agent auth',
      '  owner connected GoodVibes host',
      `  permission mode ${String(value.permissionMode)}`,
      `  operator token ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
      `  compatibility user store ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
      `  compatibility bootstrap credential ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
      '  connected-host user/session administration outside Agent',
      '  next goodvibes-agent providers',
      '  next goodvibes-agent subscription providers',
    ].join('\n'),
  );
}

export async function handleGoodVibesCliCommand(runtime: CliCommandRuntime): Promise<CliCommandResult> {
  try {
    switch (runtime.cli.command) {
      case 'onboarding':
        return runtime.cli.commandArgs[0] === 'pair'
          ? { handled: true, exitCode: await runSetupPairingCommand(runtime) }
          : { handled: false, exitCode: 0 };
      case 'run':
        return { handled: true, exitCode: await runNonInteractiveAgent(runtime) };
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
      case 'compat': {
        const result = await handleCompatCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'profiles': {
        const result = await handleProfilesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'personas': {
        const result = await handlePersonasCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'skills': {
        const result = await handleSkillsCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'memory': {
        const result = await handleMemoryCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'routines': {
        const result = await handleRoutinesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'ci': {
        const result = await handleCiCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'principals': {
        const result = await handlePrincipalsCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'owner-profile': {
        // Only a terminal is certain to be the owner reading. Captured stdout (a
        // pipe, or a shell tool a model drives) is treated as model-visible, so
        // the People section is counted there and listed only on a terminal.
        const result = await handleOwnerProfileCommand(runtime, { outputEntersModelContext: process.stdout.isTTY !== true });
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'channel-profiles': {
        const result = await handleChannelProfilesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'workspaces': {
        const result = await handleWorkspacesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'relay': {
        const result = await handleRelayCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'browser': {
        const result = await handleBrowserCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'fleet': {
        const result = await handleFleetCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'knowledge': {
        const result = await handleAgentKnowledgeCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'ask':
      case 'search': {
        const result = await handleAgentKnowledgeShortcutCommand(runtime, runtime.cli.command);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'delegate': {
        const result = await handleDelegateCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
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
        // Submitting is refused here, where that is known: the Agent's task workflow belongs to the host.
        if (runtime.cli.commandArgs[0] === 'submit') {
          const refusal = taskSubmitRefusal();
          console.log(runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(refusal, null, 2) : refusal.text);
          return { handled: true, exitCode: 2 };
        }
        const output = await handleTasks(runtime);
        if (output) console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'pair': {
        const result = await renderPairing(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'bundle': {
        const result = await handleBundleCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'import': {
        const result = await handleImportCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      default:
        return { handled: false, exitCode: 0 };
    }
  } catch (error) {
    // The catch-all for every CLI subcommand failure, and the last write before
    // entrypoint.ts exits on the returned code. Straight to the descriptor, for
    // the same reason the fatal startup report is: see utils/fatal-boot-write.ts.
    writeFatalLine(summarizeError(error));
    return { handled: true, exitCode: 1 };
  }
}

const { renderProviders, renderModels } = createCliProviderViews<CliCommandRuntime, OneShotProviderServices>(withProviderServices, {
  surface: 'agent',
  enrichModelFamilies: false,
  syntheticCatalog: false,
  inlineReceipts: false,
  binary: (runtime) => runtime.cli.binary,
  formatProviderAuthRoute,
});
