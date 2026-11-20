/**
 * `/ci` and `/principals` on the connected host: each is one description
 * shared with the terminal app (terminal-shell/ci-command.ts,
 * principals-command.ts), its methods called on the connected host. Channel
 * profiles are actions of `/channels` (terminal-shell/channels-command.ts).
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerCiCommand } from '@goodvibes/engine/terminal-shell/ci-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { formatOperatorGatewayFailure, invokeOperatorGatewayMethod } from '../../agent/operator-gateway-call.ts';
import { resolveAgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { registerPrincipalsCommand } from '@goodvibes/engine/terminal-shell/principals-command';
import { requireShellPaths } from './runtime-services.ts';

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
}
