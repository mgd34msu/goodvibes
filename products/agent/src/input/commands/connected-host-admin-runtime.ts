/**
 * The connected host's principal registry and per-channel profile admin
 * families: /principals, /channel-profiles. `/ci` is one description shared with
 * the terminal app (terminal-shell/ci-command.ts), its methods called on the
 * connected host.
 *
 * These are thin bridges onto the exact same CLI handlers the terminal
 * commands use (src/cli/ci-command.ts, principals-command.ts,
 * channel-profiles-command.ts): the TUI handler re-parses the invocation
 * through the real CLI parser and hands the result to the CLI handler, so
 * subcommand grammar, --yes confirmation gates, per-job CI conclusion
 * rendering, and connected-host failure classification can never drift
 * between the two surfaces. Output prints into the transcript verbatim.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { CliCommandOutput } from '../../cli/types.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { registerCiCommand } from '@goodvibes-jev/engine/terminal-shell/ci-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { formatOperatorGatewayFailure, invokeOperatorGatewayMethod } from '../../agent/operator-gateway-call.ts';
import { resolveAgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { registerPrincipalsCommand } from '@goodvibes-jev/engine/terminal-shell/principals-command';
import { handleChannelProfilesCommand } from '../../cli/channel-profiles-command.ts';
import { requireShellPaths } from './runtime-services.ts';
import { printCliCommandResult, refuseCliParseErrors } from './cli-command-output.ts';

function buildCliRuntime(ctx: CommandContext, command: string, args: readonly string[]): CliCommandRuntime {
  const shellPaths = requireShellPaths(ctx);
  return {
    cli: parseGoodVibesCli([command, ...args]),
    configManager: ctx.platform.configManager,
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
  };
}

async function runBridgedCliCommand(
  ctx: CommandContext,
  command: string,
  args: readonly string[],
  handler: (runtime: CliCommandRuntime) => Promise<CliCommandOutput>,
): Promise<void> {
  const runtime = buildCliRuntime(ctx, command, args);
  refuseCliParseErrors(runtime.cli.errors);
  const result = await handler(runtime);
  printCliCommandResult((text) => ctx.print(text), result);
}

/** The connected host's routes for the CI methods (the same as `goodvibes-agent ci`). */
const CI_ROUTES = {
  'ci.status': '/api/ci/status',
  'ci.watches.list': '/api/ci/watches',
  'ci.watches.create': '/api/ci/watches',
  'ci.watches.run': '/api/ci/watches/{watchId}/run',
  'ci.watches.delete': '/api/ci/watches/{watchId}',
} as const;

/** The connected host's routes for the principal methods (the same as `goodvibes-agent principals`). */
const PRINCIPALS_ROUTES = {
  'principals.list': '/api/principals',
  'principals.create': '/api/principals',
  'principals.get': '/api/principals/{principalId}',
  'principals.update': '/api/principals/{principalId}',
  'principals.delete': '/api/principals/{principalId}',
  'principals.resolve': '/api/principals/resolve',
} as const;

export function registerConnectedHostAdminCommands(registry: CommandRegistry): void {
  registerCiCommand<CommandContext>(registry, async (ctx, method, input) => {
    const shellPaths = requireShellPaths(ctx);
    const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, shellPaths.homeDirectory);
    const result = await invokeOperatorGatewayMethod(connection, method, CI_ROUTES[method], input);
    if (!result.ok) throw commandRefusal(formatOperatorGatewayFailure(result));
    return result.data;
  });
  registerPrincipalsCommand<CommandContext>(registry, async (ctx, method, input) => {
    const connection = resolveAgentConnectedHostConnection(ctx.platform.configManager, requireShellPaths(ctx).homeDirectory);
    const result = await invokeOperatorGatewayMethod(connection, method, PRINCIPALS_ROUTES[method], input);
    if (!result.ok) throw commandRefusal(formatOperatorGatewayFailure(result));
    return result.data;
  });
  registry.register({
    name: 'channel-profiles',
    effect: 'connected-host-state',
    aliases: ['channel-profile'],
    description: 'Manage per-channel session profile bindings (model, provider, permission mode) on the connected host',
    firstScreen: false,
    usage: 'list | get <surface-kind> [--channel-id <id>] | set <surface-kind> [--model <model>] [--provider <provider>] [--permission-mode <mode>] --yes | delete <surface-kind> --yes',
    argsHint: 'list | get slack',
    async handler(args, ctx) {
      await runBridgedCliCommand(ctx, 'channel-profiles', args, handleChannelProfilesCommand);
    },
  });
}
