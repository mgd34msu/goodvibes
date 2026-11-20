/**
 * Provider-native operations, one action each.
 *
 * They used to share one `provider-api` action that took an `operation` string,
 * accepted any input and was marked safe, so stopping a provider connection,
 * registering a Discord server command and reading an ntfy topic with the
 * owner's token went out unflagged. Each operation is its own action now: its
 * input schema is closed, and whether it is dangerous is stated here, beside
 * the code that has the effect, and read by the descriptors from this table.
 */
import { DiscordIntegration, NtfyIntegration, SlackIntegration } from '../../integrations/index.js';
import {
  actionOk,
  actionRefused,
  outcomeOfActionResult,
  type ChannelActionOutcome,
} from '../action-outcome.js';
import type { ChannelSurface } from '../types.js';
import { readDirectoryScope, readString, readStringList } from './parsing.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import { asProviderRuntimeSurface, isManagedSurface, providerRuntimeStatus } from './surfaces.js';
import { readNtfyTopics, resolveSurfaceSecret } from './surface-secrets.js';
import { lookupBuiltinDirectoryWithTruncation } from './targets.js';

export interface BuiltinProviderOperationContext {
  readonly deps: BuiltinChannelRuntimeDeps;
}

export interface BuiltinProviderOperation {
  /** The operator action id. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Changes a connection, a provider's state, or reads outside this daemon with the owner's credential. */
  readonly dangerous: boolean;
  readonly appliesTo: (surface: ChannelSurface) => boolean;
  readonly inputSchema: Record<string, unknown>;
  /** False when another agent tool already offers it (`live-directory` is `<surface>_directory` with `live`). */
  readonly agentTool: boolean;
  readonly run: (context: BuiltinProviderOperationContext, surface: ChannelSurface, input: Record<string, unknown> | undefined) => Promise<ChannelActionOutcome>;
}

const SLACK_DEFAULT_SCOPES = ['commands', 'chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'];

const hasProviderRuntime = (surface: ChannelSurface): boolean => asProviderRuntimeSurface(surface) !== null;

function closedSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, ...(required.length > 0 ? { required: [...required] } : {}), additionalProperties: false };
}

function noRuntime(surface: ChannelSurface): ChannelActionOutcome {
  return actionRefused({
    state: 'no provider connection manager is wired into this host',
    reason: `The ${surface} provider connection cannot be managed here.`,
    next: ['Run the daemon, which holds the provider connections, and call this action there.'],
  });
}

export const BUILTIN_PROVIDER_OPERATIONS: readonly BuiltinProviderOperation[] = [
  {
    id: 'runtime-status',
    label: 'Provider connection status',
    description: 'Return the state of the provider connection (socket or stream) this daemon holds.',
    dangerous: false,
    appliesTo: hasProviderRuntime,
    inputSchema: closedSchema({}),
    agentTool: true,
    run: async (context, surface) => {
      const providerSurface = asProviderRuntimeSurface(surface);
      return providerSurface ? actionOk({ surface, status: providerRuntimeStatus(context.deps, providerSurface) }) : noRuntime(surface);
    },
  },
  {
    id: 'runtime-start',
    label: 'Start provider connection',
    description: 'Open the provider connection (socket or stream) for this surface.',
    dangerous: true,
    appliesTo: hasProviderRuntime,
    inputSchema: closedSchema({}),
    agentTool: true,
    run: async (context, surface) => {
      const providerSurface = asProviderRuntimeSurface(surface);
      if (!providerSurface || !context.deps.providerRuntime) return noRuntime(surface);
      return outcomeOfActionResult(await context.deps.providerRuntime.start(providerSurface), ['Run the surface doctor to see which setting the connection needs.']);
    },
  },
  {
    id: 'runtime-stop',
    label: 'Stop provider connection',
    description: 'Close the provider connection for this surface; inbound messages stop arriving until it is started again.',
    dangerous: true,
    appliesTo: hasProviderRuntime,
    inputSchema: closedSchema({}),
    agentTool: true,
    run: async (context, surface) => {
      const providerSurface = asProviderRuntimeSurface(surface);
      if (!providerSurface || !context.deps.providerRuntime) return noRuntime(surface);
      return outcomeOfActionResult(context.deps.providerRuntime.stop(providerSurface));
    },
  },
  {
    id: 'live-directory',
    label: 'Search provider directory',
    description: 'Search the conversations this surface already knows and the provider directory itself.',
    dangerous: false,
    appliesTo: (surface) => isManagedSurface(surface) && surface !== 'webhook',
    inputSchema: closedSchema({
      query: { type: 'string' },
      scope: { type: 'string', enum: ['all', 'self', 'users', 'peers', 'groups', 'channels', 'threads', 'services', 'members'] },
      limit: { type: 'number' },
    }),
    agentTool: false,
    run: async (context, surface, input) => {
      if (!isManagedSurface(surface)) return actionRefused({ state: 'nothing was searched', reason: `${surface} has no provider directory.`, next: [] });
      const scope = readDirectoryScope(input?.scope);
      const { entries, truncated } = await lookupBuiltinDirectoryWithTruncation({ deps: context.deps }, surface, readString(input?.query) ?? '', {
        ...(scope ? { scope } : {}),
        ...(typeof input?.limit === 'number' ? { limit: input.limit } : {}),
        live: true,
      });
      return actionOk({ surface, entries, ...(truncated ? { truncated: true } : {}) });
    },
  },
  {
    id: 'oauth-url',
    label: 'Build install URL',
    description: 'Build the provider OAuth install URL for this surface; nothing is sent.',
    dangerous: false,
    appliesTo: (surface) => surface === 'slack' || surface === 'discord',
    inputSchema: closedSchema({
      clientId: { type: 'string' },
      redirectUri: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      state: { type: 'string' },
      teamId: { type: 'string', description: 'Slack only.' },
      guildId: { type: 'string', description: 'Discord only.' },
      permissions: { type: 'string', description: 'Discord only.' },
      disableGuildSelect: { type: 'boolean', description: 'Discord only.' },
    }),
    agentTool: true,
    run: async (context, surface, input) => {
      if (surface === 'slack') {
        const clientId = readString(input?.clientId) ?? process.env.SLACK_CLIENT_ID;
        if (!clientId) return actionRefused({ state: 'no URL was built', reason: 'Slack needs an OAuth client id.', next: ['Pass clientId, or set SLACK_CLIENT_ID.'] });
        return actionOk({
          surface,
          url: SlackIntegration.buildOAuthAuthorizeUrl({
            clientId,
            redirectUri: readString(input?.redirectUri),
            scopes: readStringList(input?.scopes) ?? SLACK_DEFAULT_SCOPES,
            state: readString(input?.state),
            teamId: readString(input?.teamId),
          }),
        });
      }
      const configuredClientId = String(context.deps.configManager.get('surfaces.discord.applicationId') || '');
      const clientId = (readString(input?.clientId) ?? configuredClientId) || process.env.DISCORD_APPLICATION_ID;
      if (!clientId) {
        return actionRefused({ state: 'no URL was built', reason: 'Discord needs an application id.', next: ['Pass clientId, set surfaces.discord.applicationId, or set DISCORD_APPLICATION_ID.'] });
      }
      return actionOk({
        surface,
        url: DiscordIntegration.buildOAuthAuthorizeUrl({
          clientId,
          redirectUri: readString(input?.redirectUri),
          guildId: readString(input?.guildId),
          permissions: readString(input?.permissions) ?? '2048',
          scopes: readStringList(input?.scopes) ?? ['bot', 'applications.commands'],
          disableGuildSelect: typeof input?.disableGuildSelect === 'boolean' ? input.disableGuildSelect : undefined,
          state: readString(input?.state),
        }),
      });
    },
  },
  {
    id: 'register-command',
    label: 'Register Discord command',
    description: 'Register the GoodVibes slash command in a Discord server with the stored bot token.',
    dangerous: true,
    appliesTo: (surface) => surface === 'discord',
    inputSchema: closedSchema({
      applicationId: { type: 'string' },
      guildId: { type: 'string' },
      command: { type: 'object', description: 'A Discord application command object; the GoodVibes command when omitted.' },
    }),
    agentTool: true,
    run: async (context, surface, input) => {
      const applicationId = readString(input?.applicationId) ?? String(context.deps.configManager.get('surfaces.discord.applicationId') || '');
      const guildId = readString(input?.guildId) ?? String(context.deps.configManager.get('surfaces.discord.guildId') || '');
      const token = await resolveSurfaceSecret(context.deps, 'discord', 'primary');
      const missing = [!applicationId && 'applicationId', !guildId && 'guildId', !token && 'the bot token'].filter(Boolean);
      if (missing.length > 0) {
        return actionRefused({
          state: 'no command was registered',
          reason: `Registering a Discord command needs ${missing.join(', ')}.`,
          next: ['Run discord setup with botToken, applicationId and guildId, or pass applicationId and guildId here.'],
        });
      }
      const discord = new DiscordIntegration(undefined, token!);
      const command = typeof input?.command === 'object' && input.command !== null
        ? input.command as ReturnType<typeof DiscordIntegration.buildGoodVibesCommand>
        : DiscordIntegration.buildGoodVibesCommand();
      return actionOk({ surface, command: await discord.registerGuildCommand(applicationId, guildId, command) });
    },
  },
  {
    id: 'subscribe-url',
    label: 'Build ntfy subscribe URLs',
    description: 'Build the JSON, WebSocket and poll URLs for an ntfy topic; nothing is read.',
    dangerous: false,
    appliesTo: (surface) => surface === 'ntfy',
    inputSchema: closedSchema({ topic: { type: 'string' }, since: { type: 'string' } }),
    agentTool: true,
    run: async (context, surface, input) => {
      // The configured topics are credentials: a URL built from one would print its name, so a topic must be given.
      const topic = readString(input?.topic);
      if (!topic) return actionRefused({ state: 'no URL was built', reason: 'No ntfy topic was given. The configured topics are credentials, so no URL is built from them here.', next: ['Pass topic.'] });
      const ntfy = new NtfyIntegration(String(context.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'));
      const since = readString(input?.since);
      return actionOk({
        surface,
        urls: {
          json: ntfy.buildSubscribeUrl(topic, 'json', { since }),
          websocket: ntfy.buildSubscribeUrl(topic, 'ws', { since }),
          poll: ntfy.buildSubscribeUrl(topic, 'json', { poll: true, since }),
        },
      });
    },
  },
  {
    id: 'poll',
    label: 'Read ntfy topic',
    description: 'Read the messages on an ntfy topic with the stored access token.',
    dangerous: true,
    appliesTo: (surface) => surface === 'ntfy',
    inputSchema: closedSchema({ topic: { type: 'string' }, since: { type: 'string' } }),
    agentTool: true,
    run: async (context, surface, input) => {
      // The default topic's name is read from the secret store its setting names.
      const topic = readString(input?.topic) ?? ((await readNtfyTopics(context.deps)).topic || undefined);
      if (!topic) return actionRefused({ state: 'nothing was read', reason: 'No ntfy topic was given and none is configured.', next: ['Pass topic, or set surfaces.ntfy.topic.'] });
      const ntfy = new NtfyIntegration(
        String(context.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'),
        await resolveSurfaceSecret(context.deps, 'ntfy', 'primary') ?? undefined,
      );
      return actionOk({ surface, messages: await ntfy.poll(topic, { since: readString(input?.since) ?? 'latest' }) });
    },
  },
];

export function providerOperationsFor(surface: ChannelSurface): readonly BuiltinProviderOperation[] {
  return BUILTIN_PROVIDER_OPERATIONS.filter((operation) => operation.appliesTo(surface));
}

export function findProviderOperation(surface: ChannelSurface, id: string): BuiltinProviderOperation | undefined {
  return providerOperationsFor(surface).find((operation) => operation.id === id);
}
