import { createCloudflareCommand } from '@goodvibes/engine/terminal-shell/cloudflare-command';
import { createCloudflareRouteClient, type CloudflareDaemonEndpoint } from '@goodvibes/engine/terminal-shell/cloudflare-control-plane';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveConnectedHostConnection } from '../connected-host-routes.ts';

/** The connected host's Cloudflare routes, with the credential every connected-host feature presents. */
function connectedHostEndpoint(ctx: CommandContext): CloudflareDaemonEndpoint {
  const connection = resolveConnectedHostConnection(ctx);
  if (connection.token) return { available: true, baseUrl: connection.baseUrl, token: connection.token };
  const unavailable = connection.unavailable;
  return {
    available: false,
    reason: unavailable
      ? `${unavailable.reason}${unavailable.next[0] ? ` Next: ${unavailable.next[0]}` : ''}`
      : `no credential for the connected host at ${connection.baseUrl} was found (${connection.tokenPath}).`,
  };
}

/**
 * /cloudflare in the Agent, over the connected host's Cloudflare routes: the
 * one description shared with the terminal app. The Agent has no guided
 * setup, so "Set Cloudflare up step by step" says which actions do it.
 * Creating a token, deploying and turning it off are the owner's to type.
 */
export function registerCloudflareRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createCloudflareCommand<CommandContext>({
    client: (ctx) => createCloudflareRouteClient({ resolveEndpoint: () => connectedHostEndpoint(ctx) }),
    readSetting: (ctx, key) => ctx.platform.configManager.get(key),
  }));
}
