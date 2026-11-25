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
  type NotificationDeadLetter, type NotificationDeadLetterSource, type NotificationReplayOptions, type NotificationReplayResult,
} from './notification-dead-letters.js';
import type { TargetChange } from '@goodvibes/engine/errors';
import { compareTarget, contentDigest, targetRef, type TargetRef } from '../utils/target-ref.js';
import { snapshotQueueStatus } from './delivery.js';
import { attachRuntimeNotifications, RUNTIME_NOTIFICATION_EVENTS, type RuntimeNotificationOptions } from './notification-dispatcher.js';
import { ServiceRegistry } from '../config/service-registry.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { resolveSurfaceSecret, type SurfaceSecretReadDeps } from '../channels/builtin/surface-secrets.js';
import { channelCredentials } from '../channels/credential-holder.js';
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

/** Where a channel posts: its webhook (by digest; the URL is a secret) or the bot's default channel. */
type NotificationDestination = TargetRef<'notification-destination'>;

interface ChannelTransport {
  readonly channel: NotifierChannel;
  /**
   * Posts `text`. `id` is the queue entry's identity, the same on every retry
   * and resend: the Discord bot sends it as the message nonce, so Discord drops
   * a repeat whose first post arrived but whose answer was lost.
   */
  readonly send: (text: string, id: string) => Promise<void>;
  /** The destination drops a repeat by that id (the Discord bot's nonce); an incoming webhook or the Slack bot does not. */
  readonly repeatSafe: boolean;
  /** Where `send` posts. A queued retry or a resend goes only to this destination. */
  readonly destination: NotificationDestination;
}

function destinationOf(channel: NotifierChannel, target: string | undefined, webhookUrl: string | undefined): NotificationDestination {
  if (target) return targetRef('notification-destination', channel, { mode: 'bot', target }, { destination: `the bot posting into ${target}` });
  const fingerprint = webhookUrl ? contentDigest(webhookUrl).slice(0, 8) : 'unknown';
  return targetRef('notification-destination', channel, { mode: 'webhook', url: webhookUrl ?? null },
    { destination: `incoming webhook ${fingerprint}` });
}

/** A destination as a dead letter keeps it: its digest and redacted text, never the URL. */
function encodeDestination(destination: NotificationDestination): string {
  return JSON.stringify({ digest: destination.digest, shown: destination.shown });
}

function decodeDestination(channel: string, stored: string | undefined): TargetRef | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { digest?: unknown; shown?: { destination?: unknown } };
    if (typeof parsed.digest !== 'string' || typeof parsed.shown?.destination !== 'string') return null;
    return { kind: 'notification-destination', id: channel, scope: null, digest: parsed.digest, shown: { destination: parsed.shown.destination } };
  } catch {
    return null;
  }
}

/** The changes between where a notification was for and where its channel posts now. */
function destinationChanges(channel: string, was: TargetRef | null, now: ChannelTransport | undefined): readonly TargetChange[] {
  if (!now) return [{ field: 'destination', was: was?.shown.destination ?? `the ${channel} destination`, now: null }];
  if (!was) return [{ field: 'destination', was: '(not recorded)', now: now.destination.shown.destination ?? 'the current destination' }];
  if (compareTarget(was, now.destination).length === 0) return [];
  return [{ field: 'destination', was: was.shown.destination ?? '(as shown)', now: now.destination.shown.destination ?? '(changed)' }];
}

function describeChanges(channel: string, changes: readonly TargetChange[]): string {
  return changes.map((change) => change.now === null
    ? `${channel} has no notification target configured any more (it was ${change.was})`
    : `${channel} now posts to ${change.now}, not ${change.was}`).join('; ');
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
  /** The incoming-webhook URLs the integrations post to, so a destination change is seen. */
  readonly slackWebhookUrl?: string | undefined;
  readonly discordWebhookUrl?: string | undefined;
}

function transportsFor(setup: NotifierChannelSetup): ChannelTransport[] {
  const transports: ChannelTransport[] = [];
  if (setup.slack) transports.push(transportFor('slack', setup.slack, setup.slackChannel, setup.slackWebhookUrl));
  if (setup.discord) transports.push(transportFor('discord', setup.discord, setup.discordChannelId, setup.discordWebhookUrl));
  return transports;
}

function setupSignature(transports: readonly ChannelTransport[], gaps: readonly NotifierChannelGap[]): string {
  return `${transports.map((transport) => transport.channel).join(',')}|${gaps.map((gap) => gap.channel).join(',')}`;
}

type NotifierSettings = Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'onDidChangeIncarnation'>>;

/**
 * The longest the notifier keeps resolved channels before a delivery resolves
 * them again. The service registry has no change signal, so an edit there (or
 * a token rotated in a password manager behind a secret reference) is picked
 * up within this time even when nothing fails; six lookups per ten minutes.
 */
const CHANNELS_MAX_AGE_MS = 10 * 60_000;

/**
 * Resolve the Slack and Discord notification channels from the services,
 * settings and environment, each credential read from its setup-schema target
 * the way status, delivery and the inbound webhooks read it
 * (channels/builtin/surface-secrets.ts): a setting whose reference does not
 * resolve gives no channel, never the environment's account.
 */
async function resolveNotifierChannels(
  credentials: SurfaceSecretReadDeps,
  configManager: NotifierSettings | null,
): Promise<NotifierChannelSetup> {
  const [slackWebhookUrl, slackBotToken, discordWebhookUrl, discordBotToken] = await Promise.all([
    resolveSurfaceSecret(credentials, 'slack', 'webhookUrl'),
    resolveSurfaceSecret(credentials, 'slack', 'primary'),
    resolveSurfaceSecret(credentials, 'discord', 'webhookUrl'),
    resolveSurfaceSecret(credentials, 'discord', 'primary'),
  ]);
  const setting = (key: 'surfaces.slack.defaultChannel' | 'surfaces.discord.defaultChannelId'): string | undefined => {
    const value = configManager?.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  const slackWebhook = slackWebhookUrl ?? undefined;
  const slackToken = slackBotToken ?? undefined;
  const discordWebhook = discordWebhookUrl ?? undefined;
  const discordToken = discordBotToken ?? undefined;
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
    slackWebhookUrl: slackWebhook || undefined,
    discordWebhookUrl: discordWebhook || undefined,
  };
}

function transportFor(channel: NotifierChannel, integration: SlackIntegration | DiscordIntegration, target: string | undefined, webhookUrl: string | undefined): ChannelTransport {
  // A default channel means the bot posts it; otherwise the incoming webhook.
  const destination = destinationOf(channel, target, webhookUrl);
  if (target) {
    if (integration instanceof DiscordIntegration) {
      return { channel, destination, repeatSafe: true, send: (text, id) => integration.postMessage(target, text, undefined, {}, `notification:${id}`) };
    }
    return { channel, destination, repeatSafe: false, send: (text) => integration.postMessage(target, text) };
  }
  return { channel, destination, repeatSafe: false, send: (text) => integration.postWebhook(text) };
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
 * on every settings change, and before a delivery only when they may be out
 * of date: none is resolved yet, the last resolution or a send failed, a
 * stored secret changed, or the last resolution is older than
 * {@link CHANNELS_MAX_AGE_MS}. A token or webhook saved during a session
 * reaches the next notification without a restart, and a burst of
 * notifications (every worker agent ending) does not repeat the secret lookups.
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
  /** When the channels were last resolved; undefined until a resolution succeeded. */
  private _resolvedAt: number | undefined;
  /** Set by a failed resolution or send, or a secret change: the next delivery resolves again first. */
  private _stale = false;
  /** Moves on every settings or secret change, so a resolution that read before a change does not count as current. */
  private _changeGeneration = 0;
  private stopWatchingSecrets: (() => void) | undefined;
  private readonly _channelListeners = new Set<() => void>();
  private stopWatchingSettings: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly _queue: DeliveryQueue<NotificationEnvelope | string>;
  private readonly metadataOnly: NotificationPrivacyReader | undefined;
  private _closed = false;
  private _closing: Promise<void> | undefined;
  private readonly _active = new Set<Promise<void>>();

  constructor(options?: NotifierChannelSetup & {
    /** Resolves the channels again: on {@link Notifier.refresh}, and before a delivery when they may be out of date. */
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
    // The setup passed in is the first resolution.
    if (this.resolveChannels) this._resolvedAt = Date.now();
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
    serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'> & Partial<Pick<ServiceRegistry, 'get'>>,
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
      /**
       * Resolves the `goodvibes://secrets/...` references an account setup flow stores
       * as bot tokens. Without it a stored reference cannot be read and the channel
       * is not built from config.
       */
      secretsManager?: (Pick<SecretsManager, 'get' | 'getGlobalHome'> & Partial<Pick<SecretsManager, 'onDidChange'>>) | null;
    } = {},
  ): Promise<Notifier> {
    const configManager = options.configManager ?? null;
    const credentials: SurfaceSecretReadDeps = {
      configManager: configManager ?? { get: () => undefined },
      serviceRegistry,
      secretsManager: options.secretsManager ?? undefined,
    };
    const resolveChannels = (): Promise<NotifierChannelSetup> => resolveNotifierChannels(credentials, configManager);
    const notifier = new Notifier({
      ...await resolveChannels(),
      resolveChannels,
      featureFlags: options.featureFlags, metadataOnly: options.metadataOnly, configManager,
    });
    // A settings change resolves the channels again; one landing during a
    // resolution resolves again once that one is done.
    notifier.stopWatchingSettings = configManager?.onDidChangeIncarnation?.(() => {
      notifier._changeGeneration += 1;
      const inFlight = notifier._resolving;
      void (inFlight ? inFlight.then(() => notifier.refresh()) : notifier.refresh());
    });
    // A stored token or webhook changed: the next delivery resolves the channels first.
    notifier.stopWatchingSecrets = options.secretsManager?.onDidChange?.(() => {
      notifier._changeGeneration += 1;
      notifier._stale = true;
    });
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
    if (this._resolving) return this._resolving;
    const generation = this._changeGeneration;
    return this._resolving = resolve().then((setup) => {
      if (this._closed) return;
      this._resolvedAt = Date.now();
      // A change that landed while this resolution read leaves the channels out of date.
      this._stale = this._changeGeneration !== generation;
      const before = setupSignature(this.transports, this.gaps);
      this.transports = transportsFor(setup);
      this.gaps = setup.gaps ?? [];
      if (setupSignature(this.transports, this.gaps) === before) return;
      for (const listener of [...this._channelListeners]) {
        try { listener(); } catch (error) { logger.warn('Notifier: channel listener failed', { error: error instanceof Error ? error.message : String(error) }); }
      }
    }, (error: unknown) => {
      this._stale = true;
      logger.warn('Notifier: notification channels could not be resolved; keeping the current ones', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this._resolving = undefined; });
  }

  /** Whether the channels held may be out of date, so a delivery resolves them first. */
  private channelsMayBeStale(): boolean {
    if (!this.resolveChannels) return false;
    return this._stale || this.transports.length === 0 || this._resolvedAt === undefined
      || Date.now() - this._resolvedAt >= CHANNELS_MAX_AGE_MS;
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
    // Channels are resolved again only when they may be out of date (see the
    // class comment): settings changes already refresh them, so the six secret
    // lookups are not paid by every notification.
    if (this.channelsMayBeStale()) await this.refresh();
    const failures: unknown[] = [];
    for (const transport of this.transports) {
      try {
        // Each attempt, the first and every retry, posts only to the destination
        // the notification was queued for: a channel changed or removed meanwhile
        // ends it in the failed list with the reason, never at the new place.
        const outcome = await this._queue.enqueue(transport.channel, event, envelope,
          (attempt) => this.sendToDestination(envelope, transport.channel, transport.destination, attempt.id),
          { target: encodeDestination(transport.destination), repeatSafe: transport.repeatSafe });
        if (outcome === 'dead_letter') {
          failures.push(new DeliveryError(`The ${transport.channel} notification could not be delivered and was moved to the failed-notification list; send it again from Failed notifications in Mail, calendar and channels, or with notifications.deadLetters.replay.`, 'terminal'));
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

  /**
   * Take in the failed notifications another file holds (a terminal program's own Slack and Discord list, 3.5.0),
   * kept in this notifier's file from now on; that file is only read. Returns how many were taken in.
   */
  adoptDeadLetters(path: string): number {
    return this._queue.adoptDeadLetters(path, notificationDeadLetterCodec(this.metadataOnly));
  }

  /** The failed notifications, oldest first, in their metadata-only form. */
  listDeadLetters(): readonly NotificationDeadLetter[] {
    return describeDeadLetters(this._queue.getDlq(), (payload) => this.queuedEnvelope(payload).describe());
  }

  /** Older failed notifications dropped from a full list since this process started; they cannot be resent. */
  droppedDeadLetters(): number {
    return this._queue.getMetrics().droppedDeadLetters;
  }

  /**
   * Resend failed notifications: all of them, or those named in `ids`. Each is
   * queued again with a fresh retry budget; an id that is not in the list is
   * reported `not-found`. A notification whose channel now posts somewhere
   * else than where it failed is not sent: it stays in the list as
   * `destination-changed`, naming both, unless `toCurrent` sends it to the
   * destination configured now.
   */
  async replayDeadLetters(ids?: readonly string[], options: NotificationReplayOptions = {}): Promise<NotificationReplayResult[]> {
    if (this.channelsMayBeStale()) await this.refresh();
    const wanted = ids === undefined ? undefined : new Set(ids);
    const refused: NotificationReplayResult[] = [];
    const sendable: string[] = [];
    const current = new Map(this.transports.map((transport) => [transport.channel as string, transport]));
    for (const entry of this._queue.getDlq()) {
      if (wanted !== undefined && !wanted.has(entry.id)) continue;
      const now = current.get(entry.channel);
      const changes = now ? destinationChanges(entry.channel, decodeDestination(entry.channel, entry.target), now) : [];
      // A channel with no target at all is left to the send below, which ends it as before.
      if (changes.length > 0 && options.toCurrent !== true) {
        refused.push({
          id: entry.id, outcome: 'destination-changed', changes,
          reason: `${describeChanges(entry.channel, changes)}; it was not sent. Resend it with --to-current (toCurrent: true) to send it there.`,
        });
        continue;
      }
      sendable.push(entry.id);
    }
    const results: NotificationReplayResult[] = sendable.length === 0 ? [] : await this._queue.replay(async (dlqEntry) => {
      const envelope = this.queuedEnvelope(dlqEntry.payload);
      const reviewed = options.toCurrent === true
        ? current.get(dlqEntry.channel)?.destination ?? decodeDestination(dlqEntry.channel, dlqEntry.target)
        : decodeDestination(dlqEntry.channel, dlqEntry.target);
      await this.sendToDestination(envelope, dlqEntry.channel, reviewed, dlqEntry.id);
    }, sendable, options.toCurrent === true
      ? (dlqEntry) => {
        const now = current.get(dlqEntry.channel);
        return now ? encodeDestination(now.destination) : dlqEntry.target;
      }
      : undefined,
    // A resend posts only through the channel's current transport (sendToDestination), so its repeat safety is that transport's.
    (dlqEntry) => current.get(dlqEntry.channel)?.repeatSafe === true);
    results.push(...refused);
    const found = new Set(results.map((result) => result.id));
    for (const id of ids ?? []) {
      if (!found.has(id)) results.push({ id, outcome: 'not-found' });
    }
    return results;
  }

  /**
   * Post to `channel` only while it still posts to `reviewed`: the destination
   * the notification was queued for (or, for a resend to the current one, the
   * destination it was resent to). Anything else is a terminal failure naming
   * both, so the queue ends it in the failed list instead of retrying it at a
   * place nobody chose for it.
   */
  private async sendToDestination(envelope: NotificationEnvelope, channel: string, reviewed: TargetRef | null, id: string): Promise<void> {
    if (this.channelsMayBeStale()) await this.refresh();
    const transport = this.transports.find((candidate) => candidate.channel === channel);
    const changes = destinationChanges(channel, reviewed, transport);
    if (changes.length > 0 || !transport) {
      throw new DeliveryError(`${describeChanges(channel, changes)}; the notification was not sent. Send it there with "send it where the channel posts now" on Failed notifications in Mail, calendar and channels.`, 'terminal');
    }
    await this.postEnvelope(envelope, (text) => transport.send(text, id));
  }

  private async postEnvelope(envelope: NotificationEnvelope, send: (text: string) => Promise<void>): Promise<void> {
    try { await send(envelope.prepare().text); }
    catch (error) {
      // A refused token or a moved webhook: the next delivery resolves the channels
      // again, and a refused credential is no longer served from the process's holder.
      this._stale = true;
      channelCredentials.releaseOnRefusal(error);
      throw error;
    }
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
    this.stopWatchingSecrets?.();
    this.stopWatchingSecrets = undefined;
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
