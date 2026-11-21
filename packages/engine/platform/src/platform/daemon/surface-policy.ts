import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema.js';
import type { ChannelSurface } from '../channels/types.js';

/** Every channel surface but the terminal and the web UI, which have their own rules below. */
type SurfaceDeliveryTarget = Exclude<ChannelSurface, 'tui' | 'web'>;

const SURFACE_CONFIG_SEGMENT: Readonly<Partial<Record<SurfaceDeliveryTarget, string>>> = { 'google-chat': 'googleChat' };

/**
 * `enabled=false` that the owner actually chose (not the schema default) wins
 * over any credential or environment variable that happens to be present.
 */
function explicitlyDisabled(configManager: ConfigManager, surface: SurfaceDeliveryTarget): boolean {
  const key = `surfaces.${SURFACE_CONFIG_SEGMENT[surface] ?? surface}.enabled` as ConfigKey;
  if (configManager.get(key) !== false) return false;
  if (typeof configManager.describeConfigKeySource !== 'function') return false;
  const source = configManager.describeConfigKeySource(key);
  return !(source.tier === 'default' && (source.effectiveOrigin === undefined || source.effectiveOrigin === 'default'));
}

const DELIVERY_TARGETS = [
  'slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'google-chat', 'signal', 'whatsapp',
  'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
] as const satisfies readonly SurfaceDeliveryTarget[];
/** A surface added to ChannelSurface and not listed above fails to compile here. */
const DELIVERY_TARGETS_COMPLETE: Exclude<SurfaceDeliveryTarget, (typeof DELIVERY_TARGETS)[number]> extends never ? true : never = true;
void DELIVERY_TARGETS_COMPLETE;

const CONFIGURED_SURFACES: ReadonlySet<string> = new Set<SurfaceDeliveryTarget>(DELIVERY_TARGETS);

/**
 * Whether inbound traffic for a surface may proceed. Credentials alone keep it
 * on (many installs run credential-only), but an owner who turned the surface
 * off in settings is obeyed: the same rule delivery applies, in one place.
 */
export function isSurfaceIngressEnabled(configManager: ConfigManager, surface: string): boolean {
  return !CONFIGURED_SURFACES.has(surface) || !explicitlyDisabled(configManager, surface as SurfaceDeliveryTarget);
}

export function isSurfaceDeliveryEnabled(
  configManager: ConfigManager,
  surface: SurfaceDeliveryTarget,
): boolean {
  if (explicitlyDisabled(configManager, surface)) return false;
  if (surface === 'slack') {
    return Boolean(configManager.get('surfaces.slack.enabled') || process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN || process.env.SLACK_WEBHOOK_URL);
  }
  if (surface === 'discord') {
    return Boolean(configManager.get('surfaces.discord.enabled') || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_WEBHOOK_URL);
  }
  if (surface === 'webhook') {
    return Boolean(configManager.get('surfaces.webhook.enabled') || configManager.get('surfaces.webhook.defaultTarget'));
  }
  if (surface === 'ntfy') {
    return Boolean(configManager.get('surfaces.ntfy.enabled') || configManager.get('surfaces.ntfy.topic') || process.env.NTFY_ACCESS_TOKEN);
  }
  const surfaces = configManager.getCategory('surfaces');
  if (surface === 'homeassistant') {
    return Boolean(
      surfaces.homeassistant.enabled
      || surfaces.homeassistant.instanceUrl
      || surfaces.homeassistant.webhookSecret
      || process.env.HOMEASSISTANT_URL
      || process.env.HOME_ASSISTANT_URL
      || process.env.HA_URL,
    );
  }
  if (surface === 'telegram') {
    return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId || process.env.TELEGRAM_BOT_TOKEN);
  }
  if (surface === 'google-chat') {
    return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId || process.env.GOOGLE_CHAT_WEBHOOK_URL);
  }
  if (surface === 'signal') {
    return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account || process.env.SIGNAL_BRIDGE_TOKEN);
  }
  if (surface === 'whatsapp') {
    return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId || process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_BRIDGE_URL || process.env.WHATSAPP_BRIDGE_TOKEN);
  }
  if (surface === 'telephony') {
    return Boolean(
      surfaces.telephony.enabled
      || surfaces.telephony.bridgeUrl
      || surfaces.telephony.accountSid
      || surfaces.telephony.defaultRecipient
      || process.env.TELEPHONY_BRIDGE_URL
      || process.env.TWILIO_ACCOUNT_SID,
    );
  }
  if (surface === 'imessage') {
    return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account || process.env.IMESSAGE_BRIDGE_TOKEN);
  }
  if (surface === 'msteams') {
    return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId || process.env.MSTEAMS_APP_ID);
  }
  if (surface === 'bluebubbles') {
    return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid || process.env.BLUEBUBBLES_SERVER_URL);
  }
  if (surface === 'mattermost') {
    return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId || process.env.MATTERMOST_BASE_URL);
  }
  if (surface === 'matrix') {
    return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId || process.env.MATRIX_HOMESERVER);
  }
  // A surface added to ChannelSurface without a rule here fails to compile.
  const unhandled: never = surface;
  return unhandled;
}

/**
 * Whether a surface is switched on: the one rule `surfaces.list`, delivery and
 * the channel accounts read. The terminal is on unless turned off; the web
 * surface follows `web.enabled` or `controlPlane.enabled`; a channel follows
 * the delivery rule above (its setting, a credential or its environment
 * variable, and an explicit off always wins). Anything else is off.
 */
export function isSurfaceEnabled(configManager: ConfigManager, surface: string): boolean {
  if (surface === 'tui') {
    const surfaces = configManager.getCategory('surfaces');
    return !('tui' in surfaces && surfaces.tui !== null && typeof surfaces.tui === 'object'
      && 'enabled' in surfaces.tui && surfaces.tui.enabled === false);
  }
  if (surface === 'web') return Boolean(configManager.get('web.enabled') || configManager.get('controlPlane.enabled'));
  return CONFIGURED_SURFACES.has(surface) && isSurfaceDeliveryEnabled(configManager, surface as SurfaceDeliveryTarget);
}
