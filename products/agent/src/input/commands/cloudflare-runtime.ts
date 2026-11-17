import { createCloudflareCommand } from '@goodvibes-jev/engine/terminal-shell/cloudflare-command';
import { createCloudflareRouteClient, type CloudflareDaemonEndpoint } from '@goodvibes-jev/engine/terminal-shell/cloudflare-control-plane';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveConnectedHostConnection } from '../connected-host-routes.ts';
import { ownerOnlyVerb, OUTWARD_VERB, READ_VERB, withCommandVerbs } from './command-verbs.ts';

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
 * /cloudflare in the Agent, over the connected host's Cloudflare routes. The
 * Agent has no setup wizard for it; `setup` says which commands set it up.
 * Creating a token, provisioning and disabling spend the owner's Cloudflare
 * account and handle its credentials, so the model may only read.
 */
export function registerCloudflareRuntimeCommands(registry: CommandRegistry): void {
  registry.register(withCommandVerbs(createCloudflareCommand<CommandContext>({
    client: (ctx) => createCloudflareRouteClient({ resolveEndpoint: () => connectedHostEndpoint(ctx) }),
    readSetting: (ctx, key) => ctx.platform.configManager.get(key),
  }), {
    defaultVerb: 'status',
    verbs: {
      status: READ_VERB,
      show: READ_VERB,
      setup: READ_VERB,
      requirements: READ_VERB,
      validate: OUTWARD_VERB,
      discover: OUTWARD_VERB,
      verify: OUTWARD_VERB,
      'create-token': ownerOnlyVerb('credential', 'creates and stores a Cloudflare API token on the owner\'s account'),
      provision: ownerOnlyVerb('outward', 'deploys Cloudflare resources on the owner\'s account and stores their credentials'),
      disable: ownerOnlyVerb('outward', 'turns the Cloudflare integration off and can revoke its token'),
    },
    otherwise: READ_VERB,
  }));
}
