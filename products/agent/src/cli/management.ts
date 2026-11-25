import { cliCommandDone, cliCommandRefusal, formatJsonOrText, type CliCommandOutput } from '@goodvibes/engine/terminal-shell/cli-output';
export { yesNo, formatJsonOrText } from '@goodvibes/engine/terminal-shell/cli-output';
import { createCliProviderViews } from '@goodvibes/engine/terminal-shell/cli-provider-views';
import { openBrowser } from '@goodvibes/engine/terminal-shell/cli-environment';
import { stableUrlHostForBindHost } from '@goodvibes/engine/platform/platform/pairing';
export { openBrowser } from '@goodvibes/engine/terminal-shell/cli-environment';
import { hasCommandFlag, isPresentConfigValue } from '@goodvibes/engine/terminal-shell/cli-arguments';
export { hasCommandFlag, isPresentConfigValue } from '@goodvibes/engine/terminal-shell/cli-arguments';
import { probeTcp as probe } from '@goodvibes/engine/terminal-shell/service-io';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import { runSetupPairingCommand, runSetupUnpairCommand } from './setup-pair-command.ts';
import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '../config/index.ts';
import { readConnectedHostOperatorToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';
import { createShellPathService } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { runCapabilityCommand, type CapabilityCliInvoke } from '@goodvibes/engine/terminal-shell/capability-cli';
import { connectionNeverMade } from '@goodvibes/engine/terminal-shell/cluster-remote-daemon-target';
import { ConnectedHostVerbError, DaemonVerbNotSentError, createAgentDaemonVerbCaller } from '../runtime/client/daemon-verbs.ts';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';
import type { GoodVibesCliParseResult } from './types.ts';
import { formatProviderAuthRoute } from './provider-auth-routes.ts';
import { cliWithFileWorkHere, daemonStartingInvoke, runSupportBundleCommand } from '@goodvibes/engine/terminal-shell/support-bundle-cli';
import { configuredDaemonIsThisMachine } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { handleImportCommand } from './import-command.ts';
import { handleSessions, handleTasks, renderPairing, renderSubscriptions, runSecrets, taskSubmitRefusal } from './management-commands.ts';
import {
  handleAgentKnowledgeCommand,
  handleAgentKnowledgeShortcutCommand,
  handleCompatCommand,
  handleDelegateCommand,
} from './agent-knowledge-command.ts';
import { handleSkillsCommand } from './skills-command.ts';
import { handleMemoryCommand } from './memory-command.ts';
import { handleProfilesCommand } from './profiles-command.ts';
import { handleCiCommand } from './ci-command.ts';
import { handlePrincipalsCommand } from './principals-command.ts';
import { handleOwnerProfileCommand } from './owner-profile-command.ts';
import { handleChannelProfilesCommand } from './channel-profiles-command.ts';
import { handleWorkspacesCommand } from './workspaces-command.ts';
import { handleBrowserCommand } from './browser-command.ts';
import { handlePluginBundlesCommand } from '@goodvibes/engine/terminal-shell/plugin-bundles-command';
import { handleRelayCommand } from './relay-command.ts';
import { handleFleetCommand } from './fleet-command.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { withProviderServices, type OneShotProviderServices } from './one-shot-services.ts';
import { dialHostForConfiguredHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';

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

/** `do` and `find` reach the connected host the way every Agent verb does (runtime/client/daemon-verbs.ts). */
function agentCapabilityInvoke(runtime: CliCommandRuntime): CapabilityCliInvoke {
  const caller = createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory });
  // A host on another machine: a bundle's or a moved setup's file is read and written on this computer (bundle-file-work.ts).
  return cliWithFileWorkHere(async (methodId, input, options) => {
    try {
      return { ok: true, data: await caller.invoke(methodId, input, { explicitUserRequest: options.explicitUserRequest }) };
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      // The host's own refusal, in its words and with its next step, as `goodvibes do` and `goodvibes-daemon do` print it.
      if (error instanceof ConnectedHostVerbError && error.said && error.code !== 'AUTH_REQUIRED') {
        return { ok: false, code: typeof code === 'string' ? code : 'refused', error: error.said.error, fix: error.said.next ?? '' };
      }
      const message = summarizeError(error).replace(/^'[^']+' failed:\s*/, '');
      // No answer at all (the connection was refused or dropped): the host was not reached, so nothing was sent to it.
      const unreached = !(error instanceof ConnectedHostVerbError) && !(error instanceof DaemonVerbNotSentError) && (error as { readonly name?: unknown } | null)?.name !== 'TimeoutError';
      if (unreached) {
        // The words `goodvibes do` and `goodvibes-daemon do` say (cluster-remote-daemon-target.ts callDaemonVerb): who was
        // not reached, why, and for a change whether it may have been applied.
        const where = configuredDaemonIsThisMachine(runtime.configManager) ? 'the daemon on this machine' : 'the connected host';
        const change = methodId !== 'capabilities.find'
          ? (connectionNeverMade(error) ? ' Nothing was sent, so nothing was changed.' : ' This change may or may not have been applied: check before repeating it.')
          : '';
        return { ok: false, code: 'unreachable', error: `could not reach ${where}`, fix: `${runtime.cli.binary} status shows the connected host (${message})${change}` };
      }
      return { ok: false, code: typeof code === 'string' ? code : 'refused', error: message, fix: `${runtime.cli.binary} status shows the connected host` };
    }
  }, () => !configuredDaemonIsThisMachine(runtime.configManager), runtime.workingDirectory);
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
 * Where THIS process connects to probe a listener on this machine: the
 * wildcard→loopback mapping of connected-host-dial.ts.
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
  const operatorToken = readConnectedHostOperatorToken(runtime.homeDirectory, resolveConnectedHostAddress(runtime.configManager).baseUrl);
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

async function renderAuth(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
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
    // A verb this binary does not take is a command-line error: exit 2, as for any usage refusal.
    return {
      ...cliCommandRefusal(runtime.cli, 'unsupported_in_agent', [
        'Unsupported: connected-host auth user/session administration is outside GoodVibes Agent.',
        'GoodVibes Agent does not create, delete, rotate, revoke, or clear connected-host users, sessions, or bootstrap credentials.',
        'Use the owning GoodVibes host for auth administration.',
      ].join('\n'), ['Use the owning GoodVibes host for auth administration.']),
      exitCode: 2,
    };
  }
  if (sub !== 'status' && sub !== 'review' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
    return cliCommandRefusal(runtime.cli, 'usage', 'Usage: goodvibes-agent auth [status|review|users|sessions]');
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
    return cliCommandDone(formatJsonOrText(runtime.cli)(
      value,
      [
        `GoodVibes Agent auth ${sub}`,
        '  owner connected GoodVibes host',
        `  operator token ${paths.operatorTokenPresent ? 'present' : 'missing'}`,
        `  operator token path ${paths.operatorTokenPath}`,
        `  ${sub} managed outside Agent`,
        '  Agent does not enumerate or mutate connected-host users/sessions from the local CLI.',
      ].join('\n'),
    ));
  }
  return cliCommandDone(formatJsonOrText(runtime.cli)(
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
  ));
}

export async function handleGoodVibesCliCommand(runtime: CliCommandRuntime): Promise<CliCommandResult> {
  try {
    switch (runtime.cli.command) {
      case 'onboarding':
        if (runtime.cli.commandArgs[0] === 'pair') return { handled: true, exitCode: await runSetupPairingCommand(runtime) };
        if (runtime.cli.commandArgs[0] === 'unpair') return { handled: true, exitCode: await runSetupUnpairCommand(runtime) };
        return { handled: false, exitCode: 0 };
      case 'run':
        return { handled: true, exitCode: await runNonInteractiveAgent(runtime) };
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
      case 'plugin': {
        const [sub, ...rest] = runtime.cli.commandArgs;
        const result = sub === 'bundles'
          ? await handlePluginBundlesCommand(runtime, rest, { binary: runtime.cli.binary, confirmed: rest.includes('--yes') })
          : { output: `Usage: ${runtime.cli.binary} plugin bundles browse <index-url-or-file>|install <ref> --sha256 <pin> [--ref <git-ref>] [--yes]|uninstall <id>|list`, exitCode: 2 };
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
      // A capability by id, and the capabilities that serve a need: the connected host's capabilities.run and capabilities.find.
      case 'do':
      case 'find':
        return { handled: true, exitCode: await runCapabilityCommand({
          program: 'goodvibes-agent', verb: runtime.cli.command, args: runtime.cli.commandArgs, json: runtime.cli.flags.outputFormat === 'json', caller: 'agent',
          // The daemon on this machine is started first when it is stopped, as the programs and the bundle forms do.
          invoke: daemonStartingInvoke(agentCapabilityInvoke(runtime), runtime), workingDirectory: runtime.workingDirectory,
        }) };
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
        // Submitting is refused here, where that is known: the Agent's task workflow belongs to the host.
        if (runtime.cli.commandArgs[0] === 'submit') {
          const refusal = taskSubmitRefusal();
          console.log(runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(refusal, null, 2) : refusal.text);
          return { handled: true, exitCode: 2 };
        }
        const result = await handleTasks(runtime);
        if (result.output) console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'pair': {
        const result = await renderPairing(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      // The support bundle is the daemon's: bundle.export, bundle.inspect and bundle.import, as `do` runs them.
      case 'bundle':
        return { handled: true, exitCode: await runSupportBundleCommand({
          binary: runtime.cli.binary, command: 'bundle', caller: 'agent', args: runtime.cli.commandArgs,
          json: runtime.cli.flags.outputFormat === 'json', yes: false,
          invoke: agentCapabilityInvoke(runtime), configManager: runtime.configManager, workingDirectory: runtime.workingDirectory,
        }) };
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
