import { resolveWebUiListener } from '../../pairing/web-origin.js';
import { unobservableRuntime } from '../health.js';
import type { ProviderRuntimeSurface } from '../provider-runtime.js';
import type {
  ChannelAccountAction,
  ChannelAccountRecord,
  ChannelRuntimeObservation,
  ChannelSecretStatus,
  ChannelSurface,
} from '../types.js';
import { accountStateForHealth, authStateForCredentials, builtinHealthState } from './health.js';
import { getBuiltinSetupSchema } from './setup-schema.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import { readSurfaceSecret } from './surface-secrets.js';
import { asProviderRuntimeSurface, resolveBuiltinConfigSecret } from './surfaces.js';
import { displaySettingValue } from '../../config/config-key-facts.js';

/**
 * A setting as an account record shows it. The record reaches operator
 * screens and the model's tool output (the `<surface>_account` tool), so a
 * credential-bearing setting (a webhook URL, an ntfy topic name) goes through
 * the one display projection: its reference, or `(secret)`.
 */
function shownSetting(deps: BuiltinChannelRuntimeDeps, key: string): unknown {
  return displaySettingValue(key, deps.configManager.get(key));
}

interface BuiltinAccountContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly providerRuntimeStatus: (surface: ProviderRuntimeSurface) => unknown;
  /**
   * What this node sees of the surface's live path. The account's `state` and
   * `authState` are read off the same health answer the status snapshot gives;
   * an absent observer is an honest `unknown`.
   */
  readonly observeRuntime?: ((surface: ChannelSurface) => ChannelRuntimeObservation) | undefined;
}

export async function buildBuiltinAccount(
  context: BuiltinAccountContext,
  surface: ChannelSurface,
): Promise<ChannelAccountRecord> {
  switch (surface) {
    case 'tui':
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Terminal UI',
        enabled: true,
        accountId: 'surface:tui',
        selfContained: true,
        secrets: [],
        metadata: { managed: 'local' },
      });
    case 'web':
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Web control plane',
        enabled: Boolean(context.deps.configManager.get('web.enabled') || context.deps.configManager.get('controlPlane.enabled')),
        accountId: 'surface:web',
        selfContained: true,
        secrets: [],
        metadata: {
          baseUrl: context.deps.configManager.get('web.publicBaseUrl'),
          // The port the web UI is served on, from the one owner of that address; absent when none is served.
          ...(() => { const port = resolveWebUiListener(context.deps.configManager)?.port; return port === undefined ? {} : { port }; })(),
        },
      });
    case 'slack': {
      const workspaceId = String(context.deps.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Slack',
        enabled: context.deps.surfaceDeliveryEnabled('slack'),
        accountId: workspaceId ?? 'surface:slack',
        workspaceId,
        secrets,
        metadata: {
          defaultChannel: context.deps.configManager.get('surfaces.slack.defaultChannel'),
          providerRuntime: context.providerRuntimeStatus('slack'),
        },
      });
    }
    case 'discord': {
      const applicationId = String(context.deps.configManager.get('surfaces.discord.applicationId') || '') || undefined;
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Discord',
        enabled: context.deps.surfaceDeliveryEnabled('discord'),
        accountId: applicationId ?? 'surface:discord',
        workspaceId: String(context.deps.configManager.get('surfaces.discord.guildId') || '') || undefined,
        secrets,
        metadata: {
          applicationId,
          defaultChannelId: context.deps.configManager.get('surfaces.discord.defaultChannelId'),
          providerRuntime: context.providerRuntimeStatus('discord'),
        },
      });
    }
    case 'ntfy': {
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'ntfy',
        enabled: context.deps.surfaceDeliveryEnabled('ntfy'),
        // One account per node; a topic name is a credential, never an id.
        accountId: 'surface:ntfy',
        secrets,
        metadata: {
          baseUrl: context.deps.configManager.get('surfaces.ntfy.baseUrl'),
          topic: shownSetting(context.deps, 'surfaces.ntfy.topic'),
          chatTopic: shownSetting(context.deps, 'surfaces.ntfy.chatTopic'),
          agentTopic: shownSetting(context.deps, 'surfaces.ntfy.agentTopic'),
          remoteTopic: shownSetting(context.deps, 'surfaces.ntfy.remoteTopic'),
          providerRuntime: context.providerRuntimeStatus('ntfy'),
        },
      });
    }
    case 'webhook': {
      const secrets = [
        ...await describeSchemaSecrets(context.deps, surface),
        await describeConfigSecret(context.deps, 'defaultTarget', 'Default target', context.deps.configManager.get('surfaces.webhook.defaultTarget')),
      ];
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Generic webhook',
        enabled: context.deps.surfaceDeliveryEnabled('webhook'),
        accountId: 'surface:webhook',
        secrets,
        metadata: {
          defaultTarget: shownSetting(context.deps, 'surfaces.webhook.defaultTarget'),
          timeoutMs: context.deps.configManager.get('surfaces.webhook.timeoutMs'),
        },
      });
    }
    case 'homeassistant': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Home Assistant',
        enabled: context.deps.surfaceDeliveryEnabled('homeassistant'),
        accountId: surfaces.homeassistant.deviceId || surfaces.homeassistant.defaultConversationId || 'surface:homeassistant',
        secrets,
        metadata: {
          instanceUrl: surfaces.homeassistant.instanceUrl,
          defaultConversationId: surfaces.homeassistant.defaultConversationId,
          deviceId: surfaces.homeassistant.deviceId,
          deviceName: surfaces.homeassistant.deviceName,
          eventType: surfaces.homeassistant.eventType,
          remoteSessionTtlMs: surfaces.homeassistant.remoteSessionTtlMs,
          setupVersion: surfaces.homeassistant.setupVersion,
        },
      });
    }
    case 'telegram': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Telegram',
        enabled: context.deps.surfaceDeliveryEnabled('telegram'),
        accountId: surfaces.telegram.botUsername || surfaces.telegram.defaultChatId || 'surface:telegram',
        secrets,
        metadata: {
          botUsername: surfaces.telegram.botUsername,
          defaultChatId: surfaces.telegram.defaultChatId,
          mode: surfaces.telegram.mode,
          setupVersion: surfaces.telegram.setupVersion,
        },
      });
    }
    case 'google-chat': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Google Chat',
        enabled: context.deps.surfaceDeliveryEnabled('google-chat'),
        accountId: surfaces.googleChat.appId || surfaces.googleChat.spaceId || 'surface:google-chat',
        secrets,
        metadata: {
          appId: surfaces.googleChat.appId,
          spaceId: surfaces.googleChat.spaceId,
          setupVersion: surfaces.googleChat.setupVersion,
        },
      });
    }
    case 'signal': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Signal',
        enabled: context.deps.surfaceDeliveryEnabled('signal'),
        accountId: surfaces.signal.account || surfaces.signal.defaultRecipient || 'surface:signal',
        secrets,
        metadata: {
          bridgeUrl: surfaces.signal.bridgeUrl,
          account: surfaces.signal.account,
          defaultRecipient: surfaces.signal.defaultRecipient,
          setupVersion: surfaces.signal.setupVersion,
        },
      });
    }
    case 'whatsapp': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = [
        ...await describeSchemaSecrets(context.deps, surface),
        await describeConfigSecret(context.deps, 'verifyToken', 'Verify token', surfaces.whatsapp.verifyToken, ['WHATSAPP_VERIFY_TOKEN']),
      ];
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'WhatsApp',
        enabled: context.deps.surfaceDeliveryEnabled('whatsapp'),
        accountId: surfaces.whatsapp.phoneNumberId || surfaces.whatsapp.defaultRecipient || 'surface:whatsapp',
        secrets,
        metadata: {
          provider: surfaces.whatsapp.provider,
          bridgeUrl: surfaces.whatsapp.bridgeUrl,
          phoneNumberId: surfaces.whatsapp.phoneNumberId,
          businessAccountId: surfaces.whatsapp.businessAccountId,
          defaultRecipient: surfaces.whatsapp.defaultRecipient,
          setupVersion: surfaces.whatsapp.setupVersion,
        },
      });
    }
    case 'telephony': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = [
        await describeConfigSecret(context.deps, 'accountSid', 'Account SID', surfaces.telephony.accountSid, ['TWILIO_ACCOUNT_SID']),
        ...await describeSchemaSecrets(context.deps, surface),
      ];
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Telephony',
        enabled: context.deps.surfaceDeliveryEnabled('telephony'),
        accountId: surfaces.telephony.accountSid || surfaces.telephony.fromNumber || 'surface:telephony',
        secrets,
        metadata: {
          provider: surfaces.telephony.provider,
          mode: surfaces.telephony.mode,
          bridgeUrl: surfaces.telephony.bridgeUrl,
          fromNumber: surfaces.telephony.fromNumber,
          defaultRecipient: surfaces.telephony.defaultRecipient,
          voiceLanguage: surfaces.telephony.voiceLanguage,
          setupVersion: surfaces.telephony.setupVersion,
        },
      });
    }
    case 'imessage': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'iMessage',
        enabled: context.deps.surfaceDeliveryEnabled('imessage'),
        accountId: surfaces.imessage.account || surfaces.imessage.defaultChatId || 'surface:imessage',
        secrets,
        metadata: {
          bridgeUrl: surfaces.imessage.bridgeUrl,
          account: surfaces.imessage.account,
          defaultChatId: surfaces.imessage.defaultChatId,
          setupVersion: surfaces.imessage.setupVersion,
        },
      });
    }
    case 'msteams': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Microsoft Teams',
        enabled: context.deps.surfaceDeliveryEnabled('msteams'),
        accountId: surfaces.msteams.defaultConversationId || surfaces.msteams.botId || surfaces.msteams.appId || 'surface:msteams',
        secrets,
        metadata: {
          appId: surfaces.msteams.appId,
          tenantId: surfaces.msteams.tenantId,
          serviceUrl: surfaces.msteams.serviceUrl,
          botId: surfaces.msteams.botId,
          defaultConversationId: surfaces.msteams.defaultConversationId,
          defaultChannelId: surfaces.msteams.defaultChannelId,
          setupVersion: surfaces.msteams.setupVersion,
        },
      });
    }
    case 'bluebubbles': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'BlueBubbles',
        enabled: context.deps.surfaceDeliveryEnabled('bluebubbles'),
        accountId: surfaces.bluebubbles.account || surfaces.bluebubbles.defaultChatGuid || 'surface:bluebubbles',
        secrets,
        metadata: {
          serverUrl: surfaces.bluebubbles.serverUrl,
          account: surfaces.bluebubbles.account,
          defaultChatGuid: surfaces.bluebubbles.defaultChatGuid,
          setupVersion: surfaces.bluebubbles.setupVersion,
        },
      });
    }
    case 'mattermost': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Mattermost',
        enabled: context.deps.surfaceDeliveryEnabled('mattermost'),
        accountId: surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId || 'surface:mattermost',
        secrets,
        metadata: {
          baseUrl: surfaces.mattermost.baseUrl,
          teamId: surfaces.mattermost.teamId,
          defaultChannelId: surfaces.mattermost.defaultChannelId,
          setupVersion: surfaces.mattermost.setupVersion,
        },
      });
    }
    case 'matrix': {
      const surfaces = context.deps.configManager.getCategory('surfaces');
      const secrets = await describeSchemaSecrets(context.deps, surface);
      return finalizeBuiltinChannelAccount(context, {
        surface,
        label: 'Matrix',
        enabled: context.deps.surfaceDeliveryEnabled('matrix'),
        accountId: surfaces.matrix.userId || surfaces.matrix.defaultRoomId || 'surface:matrix',
        secrets,
        metadata: {
          homeserverUrl: surfaces.matrix.homeserverUrl,
          userId: surfaces.matrix.userId,
          defaultRoomId: surfaces.matrix.defaultRoomId,
          setupVersion: surfaces.matrix.setupVersion,
        },
      });
    }
  }
  throw new Error(`Unsupported built-in surface: ${surface}`);
}

export async function resolveBuiltinAccount(
  context: BuiltinAccountContext,
  surface: ChannelSurface,
  accountId: string,
): Promise<ChannelAccountRecord | null> {
  const record = await buildBuiltinAccount(context, surface);
  return record.id === accountId || record.accountId === accountId || record.workspaceId === accountId
    ? record
    : null;
}

/**
 * Describe every credential the surface's setup schema declares, both whether
 * it is DECLARED and whether the declaration resolves, from the same reader the
 * send paths use (`readSurfaceSecret`), so the account cannot report a
 * credential the senders do not see or miss one they do.
 *
 * Resolution sends nothing and starts at most one password-manager command per
 * reference per process (the credential holder in channels/credential-holder.ts
 * keeps the value), so there is no excuse for inferring it from presence: a
 * `goodvibes://secrets/...` reference to a key absent from the store this
 * process reads is `unresolved`, which is the one source that explains a silent
 * channel.
 */
async function describeSchemaSecrets(
  deps: BuiltinChannelRuntimeDeps,
  surface: ChannelSurface,
): Promise<ChannelSecretStatus[]> {
  return Promise.all(getBuiltinSetupSchema(surface).secretTargets.map(async (target): Promise<ChannelSecretStatus> => {
    const reading = await readSurfaceSecret(deps, surface, target.id);
    return {
      field: target.id,
      label: target.label,
      configured: reading.declared,
      resolved: reading.value !== null,
      source: reading.source,
    };
  }));
}

/** A setting that is not a setup-schema credential but is reported beside them (an account SID, a default target). */
async function describeConfigSecret(
  deps: BuiltinChannelRuntimeDeps,
  field: string,
  label: string,
  configValue: unknown,
  envKeys: readonly string[] = [],
): Promise<ChannelSecretStatus> {
  const configPresent = hasConfiguredValue(configValue);
  const configResolved = configPresent ? await resolveBuiltinConfigSecret(deps, configValue) : null;
  const envPresent = envKeys.some((key) => hasConfiguredValue(process.env[key]));
  return {
    field,
    label,
    configured: configPresent || envPresent,
    resolved: Boolean(configResolved || envPresent),
    source: configResolved ? 'config' : envPresent ? 'env' : configPresent ? 'unresolved' : 'missing',
  };
}

function hasConfiguredValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.length > 0
      : Boolean(value);
}

/**
 * The actions an account offers. Ids are stable (an action keeps its id whatever
 * the account's state, and `available` says whether it can run now), so an
 * authorization asked for `connect` on a linked account finds it. Connect,
 * login, disconnect and logout exist only where a provider login does (Slack,
 * Discord, ntfy); every other surface is set up from its settings, and none has
 * a QR login to wait for.
 */
function buildBuiltinAccountActions(surface: ChannelSurface, configured: boolean, linked: boolean): readonly ChannelAccountAction[] {
  const action = (id: ChannelAccountAction['kind'], label: string, available: boolean): ChannelAccountAction => ({ id, label, kind: id, available });
  const providerLogin = asProviderRuntimeSurface(surface) !== null;
  return [
    action('inspect', 'Inspect account', true),
    action('setup', 'Configure surface', true),
    action('retest', 'Test credentials with the provider', configured),
    action('start', 'Start surface', configured),
    action('stop', 'Stop surface', configured),
    ...(providerLogin ? [
      action('connect', 'Connect surface', true),
      action('login', 'Login account', true),
      action('disconnect', 'Disconnect surface', linked),
      action('logout', 'Logout account', linked),
    ] : []),
  ];
}

/** The account id a surface reports when it has no identity of its own. */
const FALLBACK_ACCOUNT_ID_PREFIX = 'surface:';

function finalizeBuiltinChannelAccount(context: BuiltinAccountContext, input: {
  surface: ChannelSurface;
  label: string;
  enabled: boolean;
  /** A local surface that has nothing to configure (the terminal UI, the web control plane). */
  selfContained?: boolean | undefined;
  accountId?: string | undefined;
  workspaceId?: string | undefined;
  secrets: readonly ChannelSecretStatus[];
  metadata: Record<string, unknown>;
}): ChannelAccountRecord {
  // The `surface:<name>` fallback id is a placeholder, not an identity: counting
  // it made every surface read as configured, so `unconfigured` could never be
  // reported and a surface with nothing set up passed its doctor.
  const hasIdentity = Boolean(input.workspaceId)
    || (Boolean(input.accountId) && !input.accountId!.startsWith(FALLBACK_ACCOUNT_ID_PREFIX));
  const configured = Boolean(input.selfContained) || hasIdentity || input.secrets.some((entry) => entry.configured);
  // `state` and `authState` are not decided here. They are read off the one
  // health answer the status snapshot gives (credentials judged by the setup
  // schema's send rule, the live path checked first), so the account view and
  // the status view cannot disagree about whether this surface works.
  const runtime = context.observeRuntime?.(input.surface)
    ?? unobservableRuntime('no runtime observer was supplied, so liveness was not checked');
  const { state: health, facts } = builtinHealthState({ surface: input.surface, configured, secrets: input.secrets, metadata: input.metadata }, input.enabled, runtime);
  const linked = facts.declared;
  const id = input.accountId || input.workspaceId || `surface:${input.surface}`;
  return {
    id,
    surface: input.surface,
    label: input.label,
    enabled: input.enabled,
    configured,
    linked,
    state: accountStateForHealth(health),
    authState: authStateForCredentials(facts, input.enabled),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    secrets: input.secrets,
    actions: buildBuiltinAccountActions(input.surface, configured, linked),
    metadata: { ...input.metadata, health },
  };
}
