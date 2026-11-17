/**
 * Channel adapter capability entries, spread into FEATURE_FLAGS by flags.ts in
 * declaration order.
 *
 * Channel adapters activate through their own enabled key and credentials; the
 * capability is always present, so each binding is constant and the surface's
 * enabled key is the honest user-facing switch. The surface gate map in
 * gates.ts is derived from these ids (`<surface>-surface`).
 */
import type { FeatureFlag } from './types.js';

export const CHANNEL_SURFACE_FEATURE_FLAGS: FeatureFlag[] = [
  {
    id: 'slack-surface',
    name: 'Slack Surface',
    description:
      'Enables the Slack client adapter for interactive command ingress, threaded replies, and '
      + 'notification delivery. Inbound messages are gated by the per-surface owner allowlist '
      + '(seeded from the first identified sender; unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.slack.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.slack.enabled',
      'surfaces.slack.signingSecret',
      'surfaces.slack.botToken',
      'surfaces.slack.appToken',
      'surfaces.slack.defaultChannel',
      'surfaces.slack.workspaceId',
      'surfaces.slack.inboxUserId',
      'surfaces.slack.inboxTagging',
    ],
  },
  {
    id: 'discord-surface',
    name: 'Discord Surface',
    description:
      'Enables the Discord client adapter for interaction handling, message replies, and '
      + 'notification delivery. Inbound messages are gated by the per-surface owner allowlist '
      + '(seeded from the first identified sender; unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.discord.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.discord.enabled',
      'surfaces.discord.publicKey',
      'surfaces.discord.botToken',
      'surfaces.discord.applicationId',
      'surfaces.discord.defaultChannelId',
      'surfaces.discord.guildId',
      'surfaces.discord.inboxTagging',
    ],
  },
  {
    id: 'ntfy-surface',
    name: 'ntfy Surface',
    description:
      'Enables the ntfy notification surface for push-style delivery and deep links back into the '
      + 'control-plane UI. Inbound messages are gated by the per-surface owner allowlist when the '
      + 'sender carries an identity (unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.ntfy.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.ntfy.enabled',
      'surfaces.ntfy.baseUrl',
      'surfaces.ntfy.topic',
      'surfaces.ntfy.chatTopic',
      'surfaces.ntfy.agentTopic',
      'surfaces.ntfy.remoteTopic',
      'surfaces.ntfy.token',
      'surfaces.ntfy.defaultPriority',
    ],
  },
  {
    id: 'webhook-surface',
    name: 'Webhook Surface',
    description:
      'Enables the generic webhook surface for machine-to-machine ingress and egress. '
      + 'Ingress requires the configured webhook verification; sender-identified messages are '
      + 'additionally gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.webhook.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.webhook.enabled',
      'surfaces.webhook.defaultTarget',
      'surfaces.webhook.timeoutMs',
      'surfaces.webhook.secret',
    ],
  },
  {
    id: 'homeassistant-surface',
    name: 'Home Assistant Surface',
    description:
      'Enables the Home Assistant surface for daemon/device integration, Home Assistant '
      + 'event delivery, service-call tools, and Home Assistant-originated prompts. Inbound '
      + 'prompts are gated by the per-surface owner allowlist when the sender carries an '
      + 'identity (unknown senders are ignored).',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.homeassistant.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.homeassistant.enabled',
      'surfaces.homeassistant.instanceUrl',
      'surfaces.homeassistant.accessToken',
      'surfaces.homeassistant.webhookSecret',
      'surfaces.homeassistant.defaultConversationId',
      'surfaces.homeassistant.deviceId',
      'surfaces.homeassistant.deviceName',
      'surfaces.homeassistant.eventType',
      'surfaces.homeassistant.remoteSessionTtlMs',
    ],
  },
  // Every remaining channel adapter carries its own surface gate entry, bound
  // (constant kind) to its surfaces.<x>.enabled domain key, the honest
  // user-facing switch. The capability is always present; activation needs
  // the enabled key + credentials. Ids match the surface strings the channel
  // plugin registry registers (see channels/builtin/plugins.ts).
  {
    id: 'telegram-surface',
    name: 'Telegram Surface',
    description:
      'Enables the Telegram client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.telegram.enabled plus bot '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.telegram.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.telegram.enabled',
      'surfaces.telegram.mode',
      'surfaces.telegram.botToken',
      'surfaces.telegram.botUsername',
      'surfaces.telegram.defaultChatId',
      'surfaces.telegram.webhookSecret',
    ],
  },
  {
    id: 'whatsapp-surface',
    name: 'WhatsApp Surface',
    description:
      'Enables the WhatsApp client adapter for command ingress, interactive actions, and '
      + 'notification delivery. Activation needs surfaces.whatsapp.enabled plus API '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.whatsapp.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.whatsapp.enabled',
      'surfaces.whatsapp.provider',
      'surfaces.whatsapp.bridgeUrl',
      'surfaces.whatsapp.accessToken',
      'surfaces.whatsapp.phoneNumberId',
      'surfaces.whatsapp.businessAccountId',
      'surfaces.whatsapp.defaultRecipient',
      'surfaces.whatsapp.signingSecret',
      'surfaces.whatsapp.verifyToken',
    ],
  },
  {
    id: 'signal-surface',
    name: 'Signal Surface',
    description:
      'Enables the Signal client adapter for command ingress and notification delivery. '
      + 'Activation needs surfaces.signal.enabled plus a linked signal-cli endpoint; inbound '
      + 'messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.signal.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.signal.enabled',
      'surfaces.signal.bridgeUrl',
      'surfaces.signal.account',
      'surfaces.signal.token',
      'surfaces.signal.defaultRecipient',
    ],
  },
  {
    id: 'msteams-surface',
    name: 'Microsoft Teams Surface',
    description:
      'Enables the Microsoft Teams client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.msteams.enabled plus bot '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.msteams.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.msteams.enabled',
      'surfaces.msteams.appId',
      'surfaces.msteams.appPassword',
      'surfaces.msteams.webhookSecret',
      'surfaces.msteams.botId',
      'surfaces.msteams.tenantId',
      'surfaces.msteams.serviceUrl',
      'surfaces.msteams.defaultChannelId',
      'surfaces.msteams.defaultConversationId',
    ],
  },
  {
    id: 'matrix-surface',
    name: 'Matrix Surface',
    description:
      'Enables the Matrix client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.matrix.enabled plus homeserver '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.matrix.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.matrix.enabled',
      'surfaces.matrix.homeserverUrl',
      'surfaces.matrix.userId',
      'surfaces.matrix.accessToken',
      'surfaces.matrix.webhookSecret',
      'surfaces.matrix.defaultRoomId',
    ],
  },
  {
    id: 'mattermost-surface',
    name: 'Mattermost Surface',
    description:
      'Enables the Mattermost client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.mattermost.enabled plus server '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.mattermost.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.mattermost.enabled',
      'surfaces.mattermost.baseUrl',
      'surfaces.mattermost.botToken',
      'surfaces.mattermost.webhookSecret',
      'surfaces.mattermost.teamId',
      'surfaces.mattermost.defaultChannelId',
    ],
  },
  {
    id: 'imessage-surface',
    name: 'iMessage Surface',
    description:
      'Enables the iMessage client adapter for command ingress and notification delivery. '
      + 'Activation needs surfaces.imessage.enabled plus a bridge endpoint; inbound messages '
      + 'are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.imessage.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.imessage.enabled',
      'surfaces.imessage.bridgeUrl',
      'surfaces.imessage.account',
      'surfaces.imessage.token',
      'surfaces.imessage.defaultChatId',
    ],
  },
  {
    id: 'bluebubbles-surface',
    name: 'BlueBubbles Surface',
    description:
      'Enables the BlueBubbles client adapter for iMessage command ingress and notification '
      + 'delivery via a BlueBubbles server. Activation needs surfaces.bluebubbles.enabled '
      + 'plus server credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.bluebubbles.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.bluebubbles.enabled',
      'surfaces.bluebubbles.serverUrl',
      'surfaces.bluebubbles.password',
      'surfaces.bluebubbles.account',
      'surfaces.bluebubbles.defaultChatGuid',
    ],
  },
  {
    id: 'google-chat-surface',
    name: 'Google Chat Surface',
    description:
      'Enables the Google Chat client adapter for command ingress, threaded replies, and '
      + 'notification delivery. Activation needs surfaces.googleChat.enabled plus app '
      + 'credentials; inbound messages are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.googleChat.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.googleChat.enabled',
      'surfaces.googleChat.appId',
      'surfaces.googleChat.spaceId',
      'surfaces.googleChat.verificationToken',
      'surfaces.googleChat.webhookUrl',
    ],
  },
  {
    id: 'telephony-surface',
    name: 'Telephony Surface',
    description:
      'Enables the telephony adapter for delivery-oriented voice/SMS notification egress and '
      + 'webhook ingress. Activation needs surfaces.telephony.enabled plus provider '
      + 'credentials; inbound events are gated by the per-surface owner allowlist.',
    defaultState: 'enabled',
    tier: 10,
    runtimeToggleable: true,
    settings: { key: 'surfaces.telephony.enabled', kind: 'constant' },
    tuningKeys: [
      'surfaces.telephony.enabled',
      'surfaces.telephony.provider',
      'surfaces.telephony.mode',
      'surfaces.telephony.accountSid',
      'surfaces.telephony.authToken',
      'surfaces.telephony.fromNumber',
      'surfaces.telephony.bridgeUrl',
      'surfaces.telephony.token',
      'surfaces.telephony.defaultRecipient',
      'surfaces.telephony.voiceLanguage',
      'surfaces.telephony.webhookSecret',
    ],
  },
];
