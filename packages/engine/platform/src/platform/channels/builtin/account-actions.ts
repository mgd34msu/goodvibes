import { DiscordIntegration, NtfyIntegration, SlackIntegration } from '../../integrations/index.js';
import type { ProviderRuntimeSurface } from '../provider-runtime.js';
import type { ChannelPolicyManager } from '../policy-manager.js';
import type {
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountRecord,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelSurface,
} from '../types.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import {
  readDirectoryScope,
  readSecretScope,
  readString,
  readStringList,
} from './parsing.js';
import {
  asProviderRuntimeSurface,
  isManagedSurface,
  providerEnvBacked,
  providerRuntimeStatus,
  resolveDiscordBotToken,
  resolveNtfyToken,
} from './surfaces.js';
import { lookupBuiltinProviderDirectory } from './targets.js';

interface BuiltinAccountActionContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly buildAccount: (surface: ChannelSurface) => Promise<ChannelAccountRecord>;
  readonly resolveAccount: (surface: ChannelSurface, accountId: string) => Promise<ChannelAccountRecord | null>;
}

interface BuiltinActorAuthorizationContext extends BuiltinAccountActionContext {
  readonly channelPolicy: Pick<ChannelPolicyManager, 'start' | 'getPolicy'>;
}

export async function runBuiltinAccountAction(
  context: BuiltinAccountActionContext,
  surface: ChannelSurface,
  action: ChannelAccountLifecycleAction,
  accountId?: string,
  input?: Record<string, unknown>,
): Promise<ChannelAccountLifecycleResult> {
  const account = accountId ? await context.resolveAccount(surface, accountId) : await context.buildAccount(surface);
  const resultAccountId = accountId ?? account?.accountId ?? account?.id;
  const base = {
    surface,
    ...(resultAccountId ? { accountId: resultAccountId } : {}),
    action,
    ...(account ? { state: account.state, authState: account.authState } : {}),
    account,
  };
  if (!account) {
    return {
      ...base,
      ok: false,
      message: 'No matching channel account was found.',
      metadata: { requestedAccountId: accountId ?? null },
    };
  }
  const providerSurface = asProviderRuntimeSurface(surface);

  switch (action) {
    case 'inspect':
      return {
        ...base,
        ok: true,
        message: 'Account posture inspected.',
        metadata: {},
      };
    case 'retest':
      return {
        ...base,
        ok: account.configured,
        message: account.configured
          ? 'Account configuration is present; secret values remain hidden.'
          : 'Account is not configured.',
        metadata: { configured: account.configured, linked: account.linked },
      };
    case 'setup':
      if (providerSurface) {
        return runProviderSetupAction(context, providerSurface, action, base, account, input);
      }
      return {
        ...base,
        ok: account.configured,
        login: account.configured
          ? { kind: 'none' }
          : {
              kind: 'manual',
              instructions: 'Configure this built-in surface through GoodVibes config or the service registry.',
            },
        message: account.configured
          ? 'Account is already configured.'
          : 'This built-in surface is config-backed; interactive setup is not available for it.',
        metadata: { configBacked: true },
      };
    case 'connect':
    case 'login':
      if (providerSurface) {
        return runProviderSetupAction(context, providerSurface, action, base, account, input);
      }
      return {
        ...base,
        ok: account.linked,
        login: account.linked
          ? { kind: 'none' }
          : {
              kind: 'manual',
              instructions: 'Add the required credential sources in GoodVibes config, environment, or service registry.',
            },
        message: account.linked
          ? 'Account is already linked.'
          : 'No mutable OAuth/QR login flow is available for this config-backed built-in surface.',
        metadata: { configBacked: true },
      };
    case 'wait_login':
      return {
        ...base,
        ok: false,
        login: { kind: 'none' },
        message: 'No interactive login is pending for this built-in surface.',
        metadata: { pending: false },
      };
    case 'start':
      if (providerSurface && context.deps.providerRuntime) {
        const runtimeResult = await context.deps.providerRuntime.start(providerSurface);
        const refreshed = await context.buildAccount(surface);
        return {
          ...base,
          ok: runtimeResult.ok,
          account: refreshed,
          state: refreshed.state,
          authState: refreshed.authState,
          message: runtimeResult.message,
          metadata: { providerRuntime: runtimeResult.status },
        };
      }
      return {
        ...base,
        ok: account.enabled,
        message: account.enabled
          ? 'Surface is enabled in the current daemon runtime.'
          : 'Surface is disabled; enable it in config before starting delivery.',
        metadata: { enabled: account.enabled },
      };
    case 'stop':
      if (providerSurface && context.deps.providerRuntime) {
        const runtimeResult = context.deps.providerRuntime.stop(providerSurface);
        const refreshed = await context.buildAccount(surface);
        return {
          ...base,
          ok: runtimeResult.ok,
          account: refreshed,
          state: refreshed.state,
          authState: refreshed.authState,
          message: runtimeResult.message,
          metadata: { providerRuntime: runtimeResult.status },
        };
      }
      return {
        ...base,
        ok: !account.enabled,
        message: account.enabled
          ? 'Stopping this built-in surface is daemon/config owned; disable it in config or stop the daemon.'
          : 'Surface is already disabled.',
        metadata: { enabled: account.enabled, configBacked: true },
      };
    case 'disconnect':
    case 'logout':
      if (providerSurface) {
        return runProviderLogoutAction(context, providerSurface, action, base, account, input);
      }
      return {
        ...base,
        ok: !account.linked,
        message: account.linked
          ? 'This built-in surface is config-backed; credentials were not removed by the runtime.'
          : 'Account is already unlinked.',
        metadata: { configBacked: true, linked: account.linked },
      };
  }
}

export async function authorizeBuiltinActorAction(
  context: BuiltinActorAuthorizationContext,
  surface: ChannelSurface,
  request: ChannelActorAuthorizationRequest,
): Promise<ChannelActorAuthorizationResult> {
  const account = request.accountId ? await context.resolveAccount(surface, request.accountId) : await context.buildAccount(surface);
  const requestedAction = request.actionId.trim().toLowerCase();
  const matchingAction = account?.actions.find((entry) => entry.id === requestedAction || entry.kind === requestedAction);
  // An action name this surface does not have is refused, not defaulted to the
  // account's state: otherwise any made-up name is "allowed" on an enabled account.
  const actionAvailable = matchingAction?.available ?? false;
  // The actor is judged against the surface's user allowlist the same way
  // ingress judges a sender: an empty list restricts nobody, a non-empty one
  // admits only the listed ids and refuses an anonymous actor.
  await context.channelPolicy.start();
  const allowlistUserIds = context.channelPolicy.getPolicy(surface).allowlistUserIds;
  const actorAllowed = allowlistUserIds.length === 0
    || (request.actorId !== undefined && allowlistUserIds.includes(request.actorId));
  const allowed = Boolean(account?.enabled && actionAvailable && actorAllowed);
  return {
    allowed,
    reason: allowed
      ? 'Account is enabled, the requested action is available, and the actor passes the channel allowlist.'
      : !account
        ? 'No matching channel account was found.'
        : matchingAction === undefined
          ? `Unknown action '${request.actionId}' for this surface; known actions: ${account.actions.map((entry) => entry.id).join(', ')}.`
          : !account.enabled
            ? 'The account is disabled; enable the surface before this action.'
            : !actionAvailable
              ? `The action '${matchingAction.id}' is unavailable until the surface is configured.`
              : request.actorId === undefined
                ? 'The channel allowlist is not empty and no actorId was given; name the actor to check.'
                : `Actor '${request.actorId}' is not on the channel allowlist; add it with the allowlist edit action first.`,
    account,
    actionAvailable,
    metadata: {
      actorEvaluated: true,
      actorAllowlisted: actorAllowed,
      actorId: request.actorId ?? null,
      actionId: request.actionId,
      target: request.target?.sessionTarget ?? request.target?.to ?? null,
    },
  };
}

export async function runBuiltinProviderApi(
  context: BuiltinAccountActionContext,
  surface: ChannelSurface,
  input?: Record<string, unknown>,
): Promise<unknown> {
  const operation = readString(input?.operation)?.trim().toLowerCase();
  if (!operation) {
    return { surface, ok: false, error: 'provider-api requires operation.' };
  }
  if (operation === 'runtime_status') {
    const providerSurface = asProviderRuntimeSurface(surface);
    return providerSurface
      ? { surface, ok: true, status: providerRuntimeStatus(context.deps, providerSurface) }
      : { surface, ok: false, error: 'No provider runtime for this surface.' };
  }
  if (operation === 'runtime_start') {
    const providerSurface = asProviderRuntimeSurface(surface);
    return providerSurface && context.deps.providerRuntime
      ? context.deps.providerRuntime.start(providerSurface)
      : { surface, ok: false, error: 'No provider runtime for this surface.' };
  }
  if (operation === 'runtime_stop') {
    const providerSurface = asProviderRuntimeSurface(surface);
    return providerSurface && context.deps.providerRuntime
      ? context.deps.providerRuntime.stop(providerSurface)
      : { surface, ok: false, error: 'No provider runtime for this surface.' };
  }
  if (operation === 'live_directory') {
    if (!isManagedSurface(surface)) return { surface, ok: false, error: 'Live provider directory is only available for managed external surfaces.' };
    const scope = readDirectoryScope(input?.scope);
    const entries = await lookupBuiltinProviderDirectory({ deps: context.deps }, surface, readString(input?.query) ?? '', {
      ...(scope ? { scope } : {}),
      ...(typeof input?.limit === 'number' ? { limit: input.limit } : {}),
      live: true,
    });
    return { surface, ok: true, entries };
  }
  if (operation === 'oauth_url') {
    if (surface === 'slack') {
      const clientId = readString(input?.clientId) ?? process.env.SLACK_CLIENT_ID;
      if (!clientId) return { surface, ok: false, error: 'clientId or SLACK_CLIENT_ID is required.' };
      return {
        surface,
        ok: true,
        url: SlackIntegration.buildOAuthAuthorizeUrl({
          clientId,
          redirectUri: readString(input?.redirectUri),
          scopes: readStringList(input?.scopes) ?? ['commands', 'chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
          state: readString(input?.state),
          teamId: readString(input?.teamId),
        }),
      };
    }
    if (surface === 'discord') {
      const configuredClientId = String(context.deps.configManager.get('surfaces.discord.applicationId') || '');
      const clientId = (readString(input?.clientId) ?? configuredClientId) || process.env.DISCORD_APPLICATION_ID;
      if (!clientId) return { surface, ok: false, error: 'clientId, applicationId, or DISCORD_APPLICATION_ID is required.' };
      return {
        surface,
        ok: true,
        url: DiscordIntegration.buildOAuthAuthorizeUrl({
          clientId,
          redirectUri: readString(input?.redirectUri),
          guildId: readString(input?.guildId),
          permissions: readString(input?.permissions) ?? '2048',
          scopes: readStringList(input?.scopes) ?? ['bot', 'applications.commands'],
          disableGuildSelect: typeof input?.disableGuildSelect === 'boolean' ? input.disableGuildSelect : undefined,
          state: readString(input?.state),
        }),
      };
    }
    return { surface, ok: false, error: 'OAuth URL generation is not available for this surface.' };
  }
  if (operation === 'register_command' && surface === 'discord') {
    const applicationId = readString(input?.applicationId) ?? String(context.deps.configManager.get('surfaces.discord.applicationId') || '');
    const guildId = readString(input?.guildId) ?? String(context.deps.configManager.get('surfaces.discord.guildId') || '');
    const token = await resolveDiscordBotToken(context.deps);
    if (!applicationId || !guildId || !token) {
      return { surface, ok: false, error: 'applicationId, guildId, and bot token are required.' };
    }
    const discord = new DiscordIntegration(undefined, token);
    const command = typeof input?.command === 'object' && input.command !== null
      ? input.command as ReturnType<typeof DiscordIntegration.buildGoodVibesCommand>
      : DiscordIntegration.buildGoodVibesCommand();
    const registered = await discord.registerGuildCommand(applicationId, guildId, command);
    return { surface, ok: true, command: registered };
  }
  if (operation === 'subscribe_url' && surface === 'ntfy') {
    const topic = readString(input?.topic) ?? String(context.deps.configManager.get('surfaces.ntfy.topic') || '');
    if (!topic) return { surface, ok: false, error: 'topic is required.' };
    const ntfy = new NtfyIntegration(String(context.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'));
    return {
      surface,
      ok: true,
      urls: {
        json: ntfy.buildSubscribeUrl(topic, 'json', { since: readString(input?.since) }),
        websocket: ntfy.buildSubscribeUrl(topic, 'ws', { since: readString(input?.since) }),
        poll: ntfy.buildSubscribeUrl(topic, 'json', { poll: true, since: readString(input?.since) }),
      },
    };
  }
  if (operation === 'poll' && surface === 'ntfy') {
    const topic = readString(input?.topic) ?? String(context.deps.configManager.get('surfaces.ntfy.topic') || '');
    if (!topic) return { surface, ok: false, error: 'topic is required.' };
    const ntfy = new NtfyIntegration(
      String(context.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'),
      await resolveNtfyToken(context.deps) ?? undefined,
    );
    const messages = await ntfy.poll(topic, { since: readString(input?.since) ?? 'latest' });
    return { surface, ok: true, messages };
  }
  return { surface, ok: false, error: `Unsupported provider operation: ${operation}` };
}

async function runProviderSetupAction(
  context: BuiltinAccountActionContext,
  surface: ProviderRuntimeSurface,
  action: ChannelAccountLifecycleAction,
  base: Omit<ChannelAccountLifecycleResult, 'ok' | 'metadata'>,
  account: ChannelAccountRecord,
  input?: Record<string, unknown>,
): Promise<ChannelAccountLifecycleResult> {
  if (surface === 'slack') {
    const secretScope = readSecretScope(input?.secretScope);
    const directBotToken = readString(input?.botToken);
    const directSigningSecret = readString(input?.signingSecret);
    const directAppToken = readString(input?.appToken);
    const defaultChannel = readString(input?.defaultChannel);
    const workspaceId = readString(input?.workspaceId);
    if (directBotToken) {
      await context.deps.secretsManager.set('SLACK_BOT_TOKEN', directBotToken, { scope: secretScope });
      context.deps.configManager.set('surfaces.slack.botToken', goodVibesSecretUri('SLACK_BOT_TOKEN'));
    }
    if (directSigningSecret) {
      await context.deps.secretsManager.set('SLACK_SIGNING_SECRET', directSigningSecret, { scope: secretScope });
      context.deps.configManager.set('surfaces.slack.signingSecret', goodVibesSecretUri('SLACK_SIGNING_SECRET'));
    }
    if (directAppToken) {
      await context.deps.secretsManager.set('SLACK_APP_TOKEN', directAppToken, { scope: secretScope });
      context.deps.configManager.set('surfaces.slack.appToken', goodVibesSecretUri('SLACK_APP_TOKEN'));
    }
    if (defaultChannel) context.deps.configManager.set('surfaces.slack.defaultChannel', defaultChannel);
    if (workspaceId) context.deps.configManager.set('surfaces.slack.workspaceId', workspaceId);
    const hasDirectSlackSecret = Boolean(directBotToken || directSigningSecret || directAppToken);
    if (hasDirectSlackSecret || defaultChannel || workspaceId) {
      // Enabled only when a credential that resolves exists (just stored, or
      // already linked), never for metadata alone.
      const configured = Boolean(hasDirectSlackSecret || account.secrets.some((entry) => entry.configured && entry.resolved !== false));
      if (configured) {
        context.deps.configManager.set('surfaces.slack.enabled', true);
      }
      const refreshed = await context.buildAccount('slack');
      return {
        ...base,
        ok: configured,
        account: refreshed,
        state: refreshed.state,
        authState: refreshed.authState,
        login: { kind: 'none' },
        message: configured
          ? 'Slack configuration stored.'
          : 'Slack metadata stored; provide botToken, appToken, or signingSecret to enable Slack.',
        metadata: {
          storedSecretFields: [
            ...(directBotToken ? ['botToken'] : []),
            ...(directSigningSecret ? ['signingSecret'] : []),
            ...(directAppToken ? ['appToken'] : []),
          ],
          defaultChannel: defaultChannel ?? null,
          workspaceId: workspaceId ?? null,
        },
      };
    }

    const clientId = readString(input?.clientId) ?? process.env.SLACK_CLIENT_ID;
    const clientSecret = readString(input?.clientSecret) ?? process.env.SLACK_CLIENT_SECRET;
    const code = readString(input?.code);
    const redirectUri = readString(input?.redirectUri);
    if (code && clientId && clientSecret) {
      const exchange = await new SlackIntegration().exchangeOAuthCode({ clientId, clientSecret, code, ...(redirectUri ? { redirectUri } : {}) });
      if (exchange.ok && exchange.access_token) {
        await context.deps.secretsManager.set('SLACK_BOT_TOKEN', exchange.access_token, { scope: secretScope });
        context.deps.configManager.set('surfaces.slack.botToken', goodVibesSecretUri('SLACK_BOT_TOKEN'));
        context.deps.configManager.set('surfaces.slack.enabled', true);
        if (exchange.team?.id) context.deps.configManager.set('surfaces.slack.workspaceId', exchange.team.id);
        const refreshed = await context.buildAccount('slack');
        return {
          ...base,
          ok: true,
          account: refreshed,
          state: refreshed.state,
          authState: refreshed.authState,
          login: { kind: 'none' },
          message: 'Slack OAuth code exchanged and bot token stored in the GoodVibes secret store.',
          metadata: { oauth: true, team: exchange.team ?? null },
        };
      }
      return {
        ...base,
        ok: false,
        login: { kind: 'none' },
        message: `Slack OAuth exchange failed: ${exchange.error ?? 'unknown error'}`,
        metadata: { oauth: true, exchange },
      };
    }
    if (clientId) {
      return {
        ...base,
        ok: true,
        login: {
          kind: 'browser',
          url: SlackIntegration.buildOAuthAuthorizeUrl({
            clientId,
            redirectUri,
            scopes: readStringList(input?.scopes) ?? ['commands', 'chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
            state: readString(input?.state),
            teamId: readString(input?.teamId),
          }),
          instructions: 'Open this Slack install URL, approve the app, then rerun login with the returned code plus clientSecret.',
        },
        message: 'Slack OAuth install URL generated.',
        metadata: { oauth: true, requiresCodeExchange: true },
      };
    }

    return {
      ...base,
      ok: account.linked,
      login: account.linked
        ? { kind: 'none' }
        : {
            kind: 'manual',
            instructions: 'Provide botToken, signingSecret or appToken to store credentials, or clientId to generate the Slack install URL.',
          },
      message: account.linked
        ? 'Slack is already linked.'
        : 'Slack setup needs botToken, signingSecret, appToken or clientId; none was provided.',
      metadata: { providerNative: true, action },
    };
  }

  if (surface === 'discord') {
    const botToken = readString(input?.botToken);
    if (botToken) {
      await context.deps.secretsManager.set('DISCORD_BOT_TOKEN', botToken, { scope: readSecretScope(input?.secretScope) });
      context.deps.configManager.set('surfaces.discord.enabled', true);
    }
    const configuredApplicationId = String(context.deps.configManager.get('surfaces.discord.applicationId') || '');
    const applicationId = (readString(input?.applicationId) ?? configuredApplicationId) || process.env.DISCORD_APPLICATION_ID;
    const guildId = readString(input?.guildId);
    if (readString(input?.applicationId)) context.deps.configManager.set('surfaces.discord.applicationId', readString(input?.applicationId)!);
    if (guildId) context.deps.configManager.set('surfaces.discord.guildId', guildId);
    if (readString(input?.defaultChannelId)) context.deps.configManager.set('surfaces.discord.defaultChannelId', readString(input?.defaultChannelId)!);
    const refreshed = await context.buildAccount('discord');
    return {
      ...base,
      ok: Boolean(botToken || applicationId),
      account: refreshed,
      state: refreshed.state,
      authState: refreshed.authState,
      login: applicationId
        ? {
            kind: 'browser',
            url: DiscordIntegration.buildOAuthAuthorizeUrl({
              clientId: applicationId,
              guildId,
              permissions: readString(input?.permissions) ?? '2048',
              scopes: readStringList(input?.scopes) ?? ['bot', 'applications.commands'],
              disableGuildSelect: typeof input?.disableGuildSelect === 'boolean' ? input.disableGuildSelect : undefined,
              state: readString(input?.state),
            }),
            instructions: 'Open this Discord install URL to add the bot and slash commands to a server.',
          }
        : { kind: 'manual', instructions: 'Provide applicationId and botToken to complete Discord setup.' },
      message: botToken ? 'Discord bot token stored in the GoodVibes secret store.' : 'Discord install URL generated.',
      metadata: { oauth: true, applicationId: applicationId ?? null },
    };
  }

  if (surface === 'ntfy') {
    const topic = readString(input?.topic);
    const chatTopic = readString(input?.chatTopic);
    const agentTopic = readString(input?.agentTopic);
    const remoteTopic = readString(input?.remoteTopic);
    const token = readString(input?.token);
    const baseUrl = readString(input?.baseUrl);
    if (topic) context.deps.configManager.set('surfaces.ntfy.topic', topic);
    if (chatTopic) context.deps.configManager.set('surfaces.ntfy.chatTopic', chatTopic);
    if (agentTopic) context.deps.configManager.set('surfaces.ntfy.agentTopic', agentTopic);
    if (remoteTopic) context.deps.configManager.set('surfaces.ntfy.remoteTopic', remoteTopic);
    if (baseUrl) context.deps.configManager.set('surfaces.ntfy.baseUrl', baseUrl);
    if (token) await context.deps.secretsManager.set('NTFY_ACCESS_TOKEN', token, { scope: readSecretScope(input?.secretScope) });
    const configured = Boolean(topic || chatTopic || agentTopic || remoteTopic || token || account.configured);
    // A call that supplied nothing, on an account with nothing set up, must not
    // switch the surface on and report success.
    if (configured) context.deps.configManager.set('surfaces.ntfy.enabled', true);
    const refreshed = await context.buildAccount('ntfy');
    return {
      ...base,
      ok: configured,
      account: refreshed,
      state: refreshed.state,
      authState: refreshed.authState,
      login: { kind: 'none' },
      message: configured ? 'ntfy configuration stored.' : 'ntfy is config-backed; provide topics and optional token to configure it.',
      metadata: {
        topic: topic ?? context.deps.configManager.get('surfaces.ntfy.topic'),
        chatTopic: chatTopic ?? context.deps.configManager.get('surfaces.ntfy.chatTopic'),
        agentTopic: agentTopic ?? context.deps.configManager.get('surfaces.ntfy.agentTopic'),
        remoteTopic: remoteTopic ?? context.deps.configManager.get('surfaces.ntfy.remoteTopic'),
      },
    };
  }

  return {
    ...base,
    ok: account.linked,
    login: { kind: 'manual', instructions: 'No provider-native setup flow is available for this surface.' },
    message: `${surface} provider setup is not supported.`,
    metadata: { providerNative: false, action },
  };
}

async function runProviderLogoutAction(
  context: BuiltinAccountActionContext,
  surface: ProviderRuntimeSurface,
  action: ChannelAccountLifecycleAction,
  base: Omit<ChannelAccountLifecycleResult, 'ok' | 'metadata'>,
  account: ChannelAccountRecord,
  input?: Record<string, unknown>,
): Promise<ChannelAccountLifecycleResult> {
  const confirmed = input?.confirm === true || input?.removeSecrets === true;
  if (!confirmed) {
    return {
      ...base,
      ok: false,
      message: 'Credential removal requires confirm:true or removeSecrets:true because environment-backed secrets cannot be restored by GoodVibes.',
      metadata: { requiresConfirmation: true, linked: account.linked },
    };
  }
  if (context.deps.providerRuntime) context.deps.providerRuntime.stop(surface);
  const secrets = context.deps.secretsManager;
  if (surface === 'slack') {
    await secrets.delete('SLACK_BOT_TOKEN');
    await secrets.delete('SLACK_APP_TOKEN');
    await secrets.delete('SLACK_SIGNING_SECRET');
    await secrets.delete('SLACK_WEBHOOK_URL');
    context.deps.configManager.set('surfaces.slack.signingSecret', '');
    context.deps.configManager.set('surfaces.slack.botToken', '');
    context.deps.configManager.set('surfaces.slack.appToken', '');
  } else if (surface === 'discord') {
    await secrets.delete('DISCORD_BOT_TOKEN');
    context.deps.configManager.set('surfaces.discord.botToken', '');
  } else {
    await secrets.delete('NTFY_ACCESS_TOKEN');
    context.deps.configManager.set('surfaces.ntfy.token', '');
  }
  const refreshed = await context.buildAccount(surface);
  return {
    ...base,
    ok: true,
    account: refreshed,
    state: refreshed.state,
    authState: refreshed.authState,
    message: `${surface} GoodVibes-managed credentials removed. Environment variables, if present, still take precedence.`,
    metadata: { action, envBacked: providerEnvBacked(surface) },
  };
}

function goodVibesSecretUri(key: string): string {
  return `goodvibes://secrets/goodvibes/${encodeURIComponent(key)}`;
}
