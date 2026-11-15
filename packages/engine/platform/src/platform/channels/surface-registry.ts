import { createDomainDispatch } from '../runtime/store/index.js';
import { resolveWebBinding } from '../daemon/host-resolver.js';
import { isSurfaceIngressEnabled } from '../daemon/surface-policy.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { SurfaceRecord } from '../runtime/store/domains/surfaces.js';
import { ConfigManager } from '../config/manager.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitSurfaceCapabilityChanged, emitSurfaceDisabled, emitSurfaceEnabled } from '../runtime/emitters/surfaces.js';
import { CONFIG_SCHEMA } from '../config/schema.js';
import type { ConfigKey } from '../config/schema-types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The settings that switch a surface on or off; a change to one re-syncs the list. */
const SURFACE_SWITCH_KEYS: readonly ConfigKey[] = CONFIG_SCHEMA
  .map((setting) => setting.key as ConfigKey)
  .filter((key) => /^surfaces\.[^.]+\.enabled$/.test(key) || key === 'web.enabled' || key === 'controlPlane.enabled');

function now(): number {
  return Date.now();
}

export class SurfaceRegistry {
  private readonly configManager: ConfigManager;
  private readonly featureFlags: FeatureFlagReader;
  private readonly surfaces = new Map<string, SurfaceRecord>();
  private runtimeDispatch: DomainDispatch | null = null;
  private pluginRegistry: ChannelPluginRegistry | null = null;
  private runtimeBus: Pick<RuntimeEventBus, 'emit'> | null = null;
  private configUnsubscribes: Array<() => void> = [];

  constructor(configManager: ConfigManager, runtimeStore?: RuntimeStore, featureFlags?: FeatureFlagReader) {
    this.configManager = configManager;
    this.featureFlags = featureFlags ?? null;
    if (runtimeStore) this.runtimeDispatch = createDomainDispatch(runtimeStore);
  }

  attachRuntime(runtimeStore: RuntimeStore): void {
    this.runtimeDispatch = createDomainDispatch(runtimeStore);
    for (const surface of this.surfaces.values()) {
      this.runtimeDispatch.syncSurface(surface, 'surfaces.attach');
    }
  }

  attachPluginRegistry(pluginRegistry: ChannelPluginRegistry): void {
    this.pluginRegistry = pluginRegistry;
  }

  /**
   * Publish surface changes on `bus` (`surfaces` domain), so a client of
   * `surfaces.list` stays current without polling: switching a surface on or
   * off re-syncs the list, and each sync announces SURFACE_ENABLED,
   * SURFACE_DISABLED and SURFACE_CAPABILITY_CHANGED for what actually changed.
   * Cost: one in-memory re-sync per change of a surface switch, nothing per
   * request. Returns the detach function.
   */
  attachRuntimeBus(bus: Pick<RuntimeEventBus, 'emit'>): () => void {
    this.detachRuntimeBus();
    this.runtimeBus = bus;
    const resync = (): void => {
      try { this.syncConfiguredSurfaces(); }
      catch (error) { logger.warn('Surface list could not be re-read after a settings change', { error: summarizeError(error) }); }
    };
    this.configUnsubscribes = SURFACE_SWITCH_KEYS.map((key) => this.configManager.subscribe(key, resync));
    return () => this.detachRuntimeBus();
  }

  detachRuntimeBus(): void {
    for (const unsubscribe of this.configUnsubscribes.splice(0)) unsubscribe();
    this.runtimeBus = null;
  }

  /** Announce what changed between the last sync's record and this one's. */
  private publishChange(previous: SurfaceRecord | undefined, next: SurfaceRecord, reason: string): void {
    const bus = this.runtimeBus;
    // The first sight of a surface is its starting state, not a change.
    if (!bus || !previous) return;
    const ctx = { sessionId: 'system', source: 'surface-registry', traceId: next.id } as const;
    try {
      if (!previous.enabled && next.enabled) {
        emitSurfaceEnabled(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, accountId: next.accountId ?? next.kind });
      } else if (previous.enabled && !next.enabled) {
        emitSurfaceDisabled(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, reason });
      }
      const before = new Set(previous.capabilities);
      const after = new Set(next.capabilities);
      for (const capability of after) {
        if (!before.has(capability)) emitSurfaceCapabilityChanged(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, capability, enabled: true });
      }
      for (const capability of before) {
        if (!after.has(capability)) emitSurfaceCapabilityChanged(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, capability, enabled: false });
      }
    } catch (error) {
      logger.warn('Could not publish a surface change', { surface: next.id, error: summarizeError(error) });
    }
  }

  syncConfiguredSurfaces(): SurfaceRecord[] {
    const configuredAt = now();
    const pluginDescriptors = this.pluginRegistry?.listDescriptors() ?? [];
    const enabledForSurface = (surface: string): boolean => {
      if (!isSurfaceFeatureGateEnabled(this.featureFlags, surface)) return false;
      if (!isSurfaceIngressEnabled(this.configManager, surface)) return false;
      if (surface === 'tui') {
        const surfaces = this.configManager.getCategory('surfaces');
        return !('tui' in surfaces && surfaces.tui !== null && typeof surfaces.tui === 'object'
          && 'enabled' in surfaces.tui && surfaces.tui.enabled === false);
      }
      if (surface === 'web') return Boolean(this.configManager.get('web.enabled') || this.configManager.get('controlPlane.enabled'));
      if (surface === 'slack') return Boolean(this.configManager.get('surfaces.slack.enabled'));
      if (surface === 'discord') return Boolean(this.configManager.get('surfaces.discord.enabled'));
      if (surface === 'ntfy') return Boolean(this.configManager.get('surfaces.ntfy.enabled'));
      if (surface === 'webhook') {
        return Boolean(
          this.configManager.get('surfaces.webhook.enabled')
          || this.configManager.get('surfaces.webhook.defaultTarget')
          || this.configManager.get('surfaces.webhook.secret'),
        );
      }
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'telegram') return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId);
      if (surface === 'homeassistant') return Boolean(surfaces.homeassistant.enabled || surfaces.homeassistant.instanceUrl || surfaces.homeassistant.webhookSecret);
      if (surface === 'google-chat') return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId);
      if (surface === 'signal') return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account);
      if (surface === 'whatsapp') return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId);
      if (surface === 'telephony') return Boolean(surfaces.telephony.enabled || surfaces.telephony.bridgeUrl || surfaces.telephony.accountSid || surfaces.telephony.defaultRecipient);
      if (surface === 'imessage') return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account);
      if (surface === 'msteams') return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId);
      if (surface === 'bluebubbles') return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid);
      if (surface === 'mattermost') return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId);
      if (surface === 'matrix') return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId);
      return false;
    };
    const accountIdForSurface = (surface: string): string | undefined => {
      const surfaces = this.configManager.getCategory('surfaces');
      if (surface === 'slack') return String(this.configManager.get('surfaces.slack.workspaceId') || '') || undefined;
      if (surface === 'discord') return String(this.configManager.get('surfaces.discord.applicationId') || '') || undefined;
      if (surface === 'telegram') return surfaces.telegram.botUsername || surfaces.telegram.defaultChatId || undefined;
      if (surface === 'homeassistant') return surfaces.homeassistant.deviceId || surfaces.homeassistant.defaultConversationId || undefined;
      if (surface === 'google-chat') return surfaces.googleChat.appId || surfaces.googleChat.spaceId || undefined;
      if (surface === 'signal') return surfaces.signal.account || surfaces.signal.defaultRecipient || undefined;
      if (surface === 'whatsapp') return surfaces.whatsapp.phoneNumberId || surfaces.whatsapp.defaultRecipient || undefined;
      if (surface === 'telephony') return surfaces.telephony.accountSid || surfaces.telephony.fromNumber || surfaces.telephony.defaultRecipient || undefined;
      if (surface === 'imessage') return surfaces.imessage.account || surfaces.imessage.defaultChatId || undefined;
      if (surface === 'msteams') return surfaces.msteams.botId || surfaces.msteams.defaultConversationId || undefined;
      if (surface === 'bluebubbles') return surfaces.bluebubbles.account || surfaces.bluebubbles.defaultChatGuid || undefined;
      if (surface === 'mattermost') return surfaces.mattermost.teamId || surfaces.mattermost.defaultChannelId || undefined;
      if (surface === 'matrix') return surfaces.matrix.userId || surfaces.matrix.defaultRoomId || undefined;
      return undefined;
    };
    const records: SurfaceRecord[] = pluginDescriptors.length > 0 ? pluginDescriptors.map((descriptor) => ({
      id: `surface:${descriptor.surface}`,
      kind: descriptor.surface,
      label: descriptor.displayName,
      enabled: enabledForSurface(descriptor.surface),
      state: enabledForSurface(descriptor.surface) ? 'healthy' : 'disabled',
      configuredAt,
      lastSeenAt: configuredAt,
      ...(accountIdForSurface(descriptor.surface) ? { accountId: accountIdForSurface(descriptor.surface) } : {}),
      capabilities: [...descriptor.capabilities],
      metadata: {},
    })) : [
      {
        id: 'surface:tui',
        kind: 'tui',
        label: 'Terminal UI',
        enabled: enabledForSurface('tui'),
        state: enabledForSurface('tui') ? 'healthy' : 'disabled',
        configuredAt,
        lastSeenAt: configuredAt,
        capabilities: ['ingress', 'egress', 'session_binding'],
        metadata: {},
      },
      {
        id: 'surface:web',
        kind: 'web',
        label: 'Web control plane',
        enabled: enabledForSurface('web'),
        state: enabledForSurface('web') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'threaded_reply'],
        metadata: {
          // Anchored to the web binding resolver, the raw stored value can be
          // 0/NaN/malformed; consumers render the validated truth.
          port: resolveWebBinding({ hostMode: this.configManager.get('web.hostMode'), host: this.configManager.get('web.host'), port: this.configManager.get('web.port') }).port,
          baseUrl: this.configManager.get('web.publicBaseUrl'),
        },
      },
      {
        id: 'surface:slack',
        kind: 'slack',
        label: 'Slack',
        enabled: enabledForSurface('slack'),
        state: enabledForSurface('slack') ? 'healthy' : 'disabled',
        configuredAt,
        ...(accountIdForSurface('slack') ? { accountId: accountIdForSurface('slack') } : {}),
        capabilities: ['ingress', 'egress', 'threaded_reply', 'interactive_actions'],
        metadata: {
          defaultChannel: this.configManager.get('surfaces.slack.defaultChannel'),
        },
      },
      {
        id: 'surface:discord',
        kind: 'discord',
        label: 'Discord',
        enabled: enabledForSurface('discord'),
        state: enabledForSurface('discord') ? 'healthy' : 'disabled',
        configuredAt,
        ...(accountIdForSurface('discord') ? { accountId: accountIdForSurface('discord') } : {}),
        capabilities: ['ingress', 'egress', 'interactive_actions'],
        metadata: {
          defaultChannelId: this.configManager.get('surfaces.discord.defaultChannelId'),
          guildId: this.configManager.get('surfaces.discord.guildId'),
        },
      },
      {
        id: 'surface:ntfy',
        kind: 'ntfy',
        label: 'ntfy',
        enabled: enabledForSurface('ntfy'),
        state: enabledForSurface('ntfy') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          baseUrl: this.configManager.get('surfaces.ntfy.baseUrl'),
          topic: this.configManager.get('surfaces.ntfy.topic'),
          chatTopic: this.configManager.get('surfaces.ntfy.chatTopic'),
          agentTopic: this.configManager.get('surfaces.ntfy.agentTopic'),
          remoteTopic: this.configManager.get('surfaces.ntfy.remoteTopic'),
        },
      },
      {
        id: 'surface:webhook',
        kind: 'webhook',
        label: 'Generic webhook',
        enabled: enabledForSurface('webhook'),
        state: enabledForSurface('webhook') ? 'healthy' : 'disabled',
        configuredAt,
        capabilities: ['ingress', 'egress', 'delivery_only'],
        metadata: {
          defaultTarget: this.configManager.get('surfaces.webhook.defaultTarget'),
          timeoutMs: this.configManager.get('surfaces.webhook.timeoutMs'),
        },
      },
    ];

    // A surface that dropped out of this list (its feature gate went off, its
    // plugin was unregistered) must not stay `healthy` in the runtime store from
    // an earlier sync. The store has no removal, so it is published as disabled.
    const current = new Set(records.map((record) => record.id));
    for (const gone of this.surfaces.values()) {
      if (current.has(gone.id)) continue;
      const disabled: SurfaceRecord = { ...gone, enabled: false, state: 'disabled' };
      this.runtimeDispatch?.syncSurface(disabled, 'surfaces.sync');
      this.publishChange(gone, disabled, 'the surface is no longer available (its feature gate or plugin was removed)');
    }
    const previous = new Map(this.surfaces);
    this.surfaces.clear();
    for (const record of records) {
      this.surfaces.set(record.id, record);
      this.runtimeDispatch?.syncSurface(record, 'surfaces.sync');
      this.publishChange(previous.get(record.id), record, 'the surface was turned off (its setting, feature gate or ingress policy)');
    }
    return records;
  }

  list(): SurfaceRecord[] {
    return [...this.surfaces.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
}
