import { NotificationEnvelope, type NotificationPrivacyReader } from '../runtime/notification-envelope.js';
import type { NotificationDelivery } from '../runtime/turn-notification.js';
import { logger } from '../utils/logger.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { SlackIntegration } from './slack.js';
import { DiscordIntegration } from './discord.js';
import { DeliveryError, DeliveryQueue } from './delivery.js';
import type { DeliveryQueueConfig, IntegrationQueueStatus } from './delivery.js';
import {
  describeDeadLetters, notificationDeadLetterCodec,
  type NotificationDeadLetter, type NotificationDeadLetterSource, type NotificationReplayResult,
} from './notification-dead-letters.js';
import { snapshotQueueStatus } from './delivery.js';
import { attachRuntimeNotifications, RUNTIME_NOTIFICATION_EVENTS, type RuntimeNotificationOptions } from './notification-dispatcher.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';

const NOTIFICATION_EVENT_IDS: ReadonlySet<string> = new Set(RUNTIME_NOTIFICATION_EVENTS);
function notificationTraceEvent(event: string): string {
  // Queue identifiers/diagnostics may outlive a privacy change. Preserve known
  // runtime event IDs, but do not retain arbitrary legacy event wording there.
  return NOTIFICATION_EVENT_IDS.has(event) ? event : 'notification';
}

/** A chat service the notifier can post to. */
export type NotifierChannel = 'slack' | 'discord';

/**
 * Why a connected chat service gets no notifications: it has a bot token
 * (chat works) but neither an incoming-webhook URL nor a default channel to
 * post notifications into.
 */
export interface NotifierChannelGap {
  readonly channel: NotifierChannel;
  readonly reason: string;
  readonly next: string;
}

interface ChannelTransport {
  readonly channel: NotifierChannel;
  readonly send: (text: string) => Promise<void>;
}

/** Where notifications go, as resolved from the services, settings and environment at one moment. */
export interface NotifierChannelSetup {
  readonly slack?: SlackIntegration | undefined;
  readonly discord?: DiscordIntegration | undefined;
  /** Post Slack notifications with the bot into this channel instead of through the webhook. */
  readonly slackChannel?: string | undefined;
  /** Post Discord notifications with the bot into this channel instead of through the webhook. */
  readonly discordChannelId?: string | undefined;
  /** Connected services that have no notification target, reported by {@link Notifier.channelGaps}. */
  readonly gaps?: readonly NotifierChannelGap[] | undefined;
}

function transportsFor(setup: NotifierChannelSetup): ChannelTransport[] {
  const transports: ChannelTransport[] = [];
  if (setup.slack) transports.push(transportFor('slack', setup.slack, setup.slackChannel));
  if (setup.discord) transports.push(transportFor('discord', setup.discord, setup.discordChannelId));
  return transports;
}

function setupSignature(transports: readonly ChannelTransport[], gaps: readonly NotifierChannelGap[]): string {
  return `${transports.map((transport) => transport.channel).join(',')}|${gaps.map((gap) => gap.channel).join(',')}`;
}

type NotifierSettings = Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'onDidChangeIncarnation'>>;

/** Resolve the Slack and Discord notification channels from the services, settings and environment. */
async function resolveNotifierChannels(
  serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>,
  configManager: NotifierSettings | null,
  resolveConfigSecret: (value: unknown) => Promise<string | null>,
): Promise<NotifierChannelSetup> {
  const [
    slackWebhookFromService,
    slackTokenFromService,
    discordWebhookFromService,
    discordTokenFromService,
    slackTokenFromConfig,
    discordTokenFromConfig,
  ] = await Promise.all([
    serviceRegistry.resolveSecret('slack', 'webhookUrl'),
    serviceRegistry.resolveSecret('slack', 'primary'),
    serviceRegistry.resolveSecret('discord', 'webhookUrl'),
    serviceRegistry.resolveSecret('discord', 'primary'),
    configManager ? resolveConfigSecret(configManager.get('surfaces.slack.botToken')) : null,
    configManager ? resolveConfigSecret(configManager.get('surfaces.discord.botToken')) : null,
  ]);
  const setting = (key: 'surfaces.slack.defaultChannel' | 'surfaces.discord.defaultChannelId'): string | undefined => {
    const value = configManager?.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  const slackWebhook = slackWebhookFromService ?? process.env.SLACK_WEBHOOK_URL;
  const slackToken = slackTokenFromService ?? slackTokenFromConfig ?? process.env.SLACK_BOT_TOKEN;
  const discordWebhook = discordWebhookFromService ?? process.env.DISCORD_WEBHOOK_URL;
  const discordToken = discordTokenFromService ?? discordTokenFromConfig ?? process.env.DISCORD_BOT_TOKEN;
  // The webhook wins when both exist: it is the address the owner gave for notifications.
  const slackChannel = slackWebhook ? undefined : slackToken ? setting('surfaces.slack.defaultChannel') : undefined;
  const discordChannelId = discordWebhook ? undefined : discordToken ? setting('surfaces.discord.defaultChannelId') : undefined;

  const gaps: NotifierChannelGap[] = [];
  if (!slackWebhook && slackToken && !slackChannel) {
    gaps.push({
      channel: 'slack',
      reason: 'Slack is connected for chat but has nowhere to post notifications',
      next: 'Add an incoming-webhook URL to the slack service, or set surfaces.slack.defaultChannel',
    });
  }
  if (!discordWebhook && discordToken && !discordChannelId) {
    gaps.push({
      channel: 'discord',
      reason: 'Discord is connected for chat but has nowhere to post notifications',
      next: 'Add a webhook URL to the discord service, or set surfaces.discord.defaultChannelId',
    });
  }

  return {
    slack: slackWebhook || slackChannel ? new SlackIntegration(slackWebhook, slackToken) : undefined,
    discord: discordWebhook || discordChannelId ? new DiscordIntegration(discordWebhook, discordToken) : undefined,
    slackChannel,
    discordChannelId,
    gaps,
  };
}

function transportFor(channel: NotifierChannel, integration: SlackIntegration | DiscordIntegration, target: string | undefined): ChannelTransport {
  // A default channel means the bot posts it; otherwise the incoming webhook.
  if (target) return { channel, send: (text) => integration.postMessage(target, text) };
  return { channel, send: (text) => integration.postWebhook(text) };
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Notifier: the Slack and Discord notification transport.
 *
 * A channel exists only when it has somewhere to post: an incoming-webhook URL
 * (service registry `webhookUrl`, or SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL),
 * or a bot token together with a default channel (`surfaces.slack.defaultChannel`,
 * `surfaces.discord.defaultChannelId`). A bot token alone is reported through
 * {@link Notifier.channelGaps} and gets no channel.
 *
 * A notifier built by {@link Notifier.fromConfig} resolves its channels again
 * before each delivery and on every settings change, so a token or webhook
 * saved during a session reaches the next notification without a restart.
 *
 * Which events are announced and how they are worded belongs to
 * `notification-dispatcher.ts`; failures are retried by the delivery queue and
 * end in a dead-letter list that {@link Notifier.persistDeadLetters} keeps on disk.
 */
export class Notifier implements NotificationDeadLetterSource {
  private transports: readonly ChannelTransport[];
  private gaps: readonly NotifierChannelGap[];
  private readonly resolveChannels: (() => Promise<NotifierChannelSetup>) | undefined;
  private _resolving: Promise<void> | undefined;
  private readonly _channelListeners = new Set<() => void>();
  private stopWatchingSettings: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly _queue: DeliveryQueue<NotificationEnvelope | string>;
  private readonly metadataOnly: NotificationPrivacyReader | undefined;
  private _closed = false;
  private _closing: Promise<void> | undefined;
  private readonly _active = new Set<Promise<void>>();

  constructor(options?: NotifierChannelSetup & {
    /** Resolves the channels again, before each delivery and on {@link Notifier.refresh}. */
    resolveChannels?: (() => Promise<NotifierChannelSetup>) | undefined;
    delivery?: Partial<DeliveryQueueConfig> | undefined;
    featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
    metadataOnly?: NotificationPrivacyReader | undefined;
    /** Source of the integrations.delivery.* retry, backoff, dead-letter and SLO settings. */
    configManager?: Pick<ConfigManager, 'get'> | null | undefined;
  }) {
    this.metadataOnly = options?.metadataOnly;
    this.transports = transportsFor(options ?? {});
    this.gaps = options?.gaps ?? [];
    this.resolveChannels = options?.resolveChannels;
    this._queue = new DeliveryQueue<NotificationEnvelope | string>({
      ...(options?.delivery ?? {}),
      featureFlags: options?.featureFlags,
      configManager: options?.configManager,
      diagnosticMode: 'structural',
    });
  }

  /**
   * Create a Notifier from configured services, settings and environment variables.
   */
  static async fromConfig(
    serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>,
    options: {
      featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
      metadataOnly?: NotificationPrivacyReader;
      /**
       * Supplies `surfaces.slack.botToken`, `surfaces.discord.botToken` (the
       * tokens an account setup flow stores), the default channels and the
       * integrations.delivery.* settings. Without it only the service registry
       * and the environment are read. When it reports settings changes, the
       * channels are resolved again on each one.
       */
      configManager?: NotifierSettings | null;
      /** Resolves a config value that is a secret reference; defaults to {@link resolveSecretInput}. */
      resolveConfigSecret?: (value: unknown) => Promise<string | null>;
      /**
       * Resolves the `goodvibes://secrets/...` references an account setup flow stores
       * as bot tokens. Without it (or `resolveConfigSecret`) a stored reference cannot
       * be read and the channel is not built from config.
       */
      secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | null;
    } = {},
  ): Promise<Notifier> {
    const resolveConfigSecret = options.resolveConfigSecret ?? ((value: unknown) => resolveSecretInput(value, options.secretsManager
      ? { resolveLocalSecret: (key) => options.secretsManager!.get(key), homeDirectory: options.secretsManager.getGlobalHome() }
      : undefined));
    const configManager = options.configManager ?? null;
    const resolveChannels = (): Promise<NotifierChannelSetup> => resolveNotifierChannels(serviceRegistry, configManager, resolveConfigSecret);
    const notifier = new Notifier({
      ...await resolveChannels(),
      resolveChannels,
      featureFlags: options.featureFlags, metadataOnly: options.metadataOnly, configManager,
    });
    notifier.stopWatchingSettings = configManager?.onDidChangeIncarnation?.(() => { void notifier.refresh(); });
    return notifier;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** The channels this notifier posts to. */
  get channels(): readonly NotifierChannel[] {
    return this.transports.map((transport) => transport.channel);
  }

  /** Connected chat services that receive no notifications, and what to add. */
  channelGaps(): readonly NotifierChannelGap[] {
    return this.gaps;
  }

  /**
   * Resolve the channels again from the services, settings and environment. A
   * resolution that fails keeps the channels already in use; concurrent calls
   * share one resolution. Listeners of {@link onChannelsChanged} are told when
   * a channel or a gap appeared or went away.
   */
  refresh(): Promise<void> {
    const resolve = this.resolveChannels;
    if (!resolve || this._closed) return Promise.resolve();
    return this._resolving ??= resolve().then((setup) => {
      if (this._closed) return;
      const before = setupSignature(this.transports, this.gaps);
      this.transports = transportsFor(setup);
      this.gaps = setup.gaps ?? [];
      if (setupSignature(this.transports, this.gaps) === before) return;
      for (const listener of [...this._channelListeners]) {
        try { listener(); } catch (error) { logger.warn('Notifier: channel listener failed', { error: error instanceof Error ? error.message : String(error) }); }
      }
    }, (error: unknown) => {
      logger.warn('Notifier: notification channels could not be resolved; keeping the current ones', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this._resolving = undefined; });
  }

  /** Told when the set of channels or channel gaps changes. Returns the unsubscribe function. */
  onChannelsChanged(listener: () => void): () => void {
    this._channelListeners.add(listener);
    return () => { this._channelListeners.delete(listener); };
  }

  /**
   * Send a plain notification to all configured channels: `event`, then the
   * payload as key=value pairs. Runtime events are announced through
   * {@link attachToRuntimeBus}, which owns their wording.
   */
  notify(event: string, data: Record<string, unknown>): Promise<void> {
    return this.ownNotification(notificationTraceEvent(event), () => NotificationEnvelope.legacy(() => this.formatText(event, data), this.metadataOnly));
  }

  /** Send owned typed facts, with live privacy checks on every delivery attempt. */
  notifyNotification(delivery: NotificationDelivery, event = 'notification'): Promise<void> {
    return this.ownNotification(notificationTraceEvent(event), () => NotificationEnvelope.typed(delivery, this.metadataOnly));
  }

  private ownNotification(event: string, create: () => NotificationEnvelope): Promise<void> {
    if (this._closed) return Promise.reject(new DeliveryError('Notifier is closed.', 'terminal'));
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const active = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    this._active.add(active);
    void active.then(() => this._active.delete(active), () => this._active.delete(active));
    // Capture the immutable snapshot before any asynchronous delivery begins.
    void (async () => { await this.deliverNotification(event, create()); })().then(resolve, reject);
    return active;
  }

  private async deliverNotification(event: string, envelope: NotificationEnvelope): Promise<void> {
    // Every channel is attempted, in order: a Slack failure must not cost the
    // Discord copy. A failure still reaches the caller once all were tried.
    // A 'retrying' outcome is accepted: the queue still holds the message and
    // will resend it. 'dead_letter' means the queue gave up; the entry stays in
    // the dead-letter list until it is resent or cleared.
    // Channels are resolved at send time: a webhook or token saved since the
    // last notification is used now (a few secret lookups per notification).
    await this.refresh();
    const failures: unknown[] = [];
    for (const transport of this.transports) {
      try {
        const outcome = await this._queue.enqueue(transport.channel, event, envelope, () => this.postEnvelope(envelope, transport.send));
        if (outcome === 'dead_letter') {
          failures.push(new DeliveryError(`The ${transport.channel} notification could not be delivered and was moved to the failed-notification list; resend it with /notify resend or notifications.deadLetters.replay.`, 'terminal'));
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Notification delivery failed on more than one channel');
  }

  /**
   * Get delivery queue status snapshots for all active channels.
   * Used by integration diagnostics to surface queue and DLQ state.
   */
  getQueueStatus(): IntegrationQueueStatus[] {
    const sloEnforced = this._queue.sloEnforced;
    return this.transports.map((transport) =>
      snapshotQueueStatus(transport.channel, this._queue, sloEnforced, (payload) => this.queuedEnvelope(payload).describe()));
  }

  /** Told each time a notification moves to the dead-letter list. Returns the unsubscribe function. */
  onDeadLetter(listener: (channel: string) => void): () => void {
    return this._queue.onDeadLetter((entry) => listener(entry.channel));
  }

  /**
   * Keep failed notifications in `path` so they survive a restart and can
   * still be listed and resent. Entries already in the file are loaded now.
   */
  persistDeadLetters(path: string): void {
    this._queue.persistDeadLetters(path, notificationDeadLetterCodec(this.metadataOnly));
  }

  /** The failed notifications, oldest first, in their metadata-only form. */
  listDeadLetters(): readonly NotificationDeadLetter[] {
    return describeDeadLetters(this._queue.getDlq(), (payload) => this.queuedEnvelope(payload).describe());
  }

  /**
   * Resend failed notifications: all of them, or those named in `ids`. Each is
   * queued again with a fresh retry budget; an id that is not in the list is
   * reported `not-found`.
   */
  async replayDeadLetters(ids?: readonly string[]): Promise<NotificationReplayResult[]> {
    const results: NotificationReplayResult[] = await this._queue.replay(async (dlqEntry) => {
      const envelope = this.queuedEnvelope(dlqEntry.payload);
      const transport = this.transports.find((candidate) => candidate.channel === dlqEntry.channel);
      if (!transport) {
        throw new DeliveryError(`${dlqEntry.channel} has no notification target configured any more.`, 'terminal');
      }
      await this.postEnvelope(envelope, transport.send);
    }, ids);
    const found = new Set(results.map((result) => result.id));
    for (const id of ids ?? []) {
      if (!found.has(id)) results.push({ id, outcome: 'not-found' });
    }
    return results;
  }

  private async postEnvelope(envelope: NotificationEnvelope, send: (text: string) => Promise<void>): Promise<void> {
    try { await send(envelope.prepare().text); }
    finally { envelope.refreshPrivacy(); }
  }

  private queuedEnvelope(payload: NotificationEnvelope | string): NotificationEnvelope {
    return payload instanceof NotificationEnvelope ? payload : NotificationEnvelope.restoredLegacy();
  }

  /** Stop subscriptions and admission immediately; use close() to drain deliveries. */
  dispose(): void {
    this._closed = true;
    this.stopWatchingSettings?.();
    this.stopWatchingSettings = undefined;
    this._channelListeners.clear();
    this.detach();
    this._queue.dispose();
  }

  /** Await every admitted notification and its in-flight delivery before releasing dependencies. */
  close(): Promise<void> {
    this.dispose();
    return this._closing ??= Promise.allSettled([
      this._queue.close(), ...this._active,
    ]).then(() => {});
  }

  /**
   * Announce agent and workstream outcomes from `bus` (see
   * notification-dispatcher.ts for the events and their wording).
   */
  attachToRuntimeBus(bus: RuntimeEventBus, options: RuntimeNotificationOptions = {}): void {
    if (this._closed) throw new DeliveryError('Notifier is closed.', 'terminal');
    this.detach();
    this.unsubscribe = attachRuntimeNotifications(bus, (delivery, event) => this.notifyNotification(delivery, event), options);
    logger.info('Notifier: attached to RuntimeEventBus');
  }

  /** Remove all notification subscriptions. */
  detach(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private formatText(event: string, data: Record<string, unknown>): string {
    const extras = Object.entries(data)
      .filter(([k]) => k !== 'event')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    return extras ? `${event}: ${extras}` : event;
  }
}
