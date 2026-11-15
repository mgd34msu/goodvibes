import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import { resolveSurfaceSecret } from './builtin/surface-secrets.js';
import {
  DiscordGatewayClient,
  DiscordIntegration,
  NtfyIntegration,
  SlackIntegration,
  SlackSocketModeClient,
  createNtfyLiveSubscriptionSince,
  type DiscordGatewayDispatch,
  type NtfyMessage,
  type SlackSocketModeEnvelope,
  resolveGoodVibesNtfyTopics,
} from '../integrations/index.js';
import {
  type SurfaceAdapterContext,
  handleDiscordGatewayDispatchPayload,
  handleNtfySurfacePayload,
  handleSlackSurfacePayload,
} from '../adapters/index.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type ProviderRuntimeSurface = 'slack' | 'discord' | 'ntfy';

export interface ProviderRuntimeStatus {
  readonly surface: ProviderRuntimeSurface;
  readonly running: boolean;
  readonly configured: boolean;
  readonly transport: 'socket-mode' | 'gateway' | 'json-stream';
  readonly lastStartedAt?: number | undefined;
  readonly lastStoppedAt?: number | undefined;
  readonly lastError?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/** Options that apply when a surface is (re)started. */
export interface ProviderRuntimeStartOptions {
  /**
   * Wall-clock ms to replay ntfy from, the last moment the previous
   * responsible node was heard from. Null or absent subscribes live.
   */
  readonly replayFromMs?: number | null | undefined;
}

export interface ProviderRuntimeActionResult {
  readonly ok: boolean;
  readonly surface: ProviderRuntimeSurface;
  readonly status: ProviderRuntimeStatus;
  readonly message: string;
}

interface ProviderRuntimeManagerDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  /**
   * Where a message this node read off a live stream and then failed to process
   * becomes something the owner hears about.
   *
   * These three surfaces need it MORE than the webhook ones, not less: Slack
   * Socket Mode and the Discord gateway have no ack, no cursor and no
   * redelivery, and ntfy redelivers a failed message only a bounded number of
   * times. Once an event is given up on, the catch is the last place it
   * exists. Losing it quietly is structural here, so saying so is the only
   * remedy available.
   */
  readonly ingressAlarm?: import('./ingress-alarm.js').ChannelIngressAlarm | undefined;
  /** Posts a reply to a Slack `response_url`; defaults to an HTTPS POST. Injectable for tests. */
  readonly postSlackResponse?: ((url: string, body: Record<string, unknown>) => Promise<void>) | undefined;
}

interface RuntimeState {
  running: boolean;
  lastStartedAt?: number | undefined;
  lastStoppedAt?: number | undefined;
  lastError?: string | undefined;
  metadata: Record<string, unknown>;
}

const DEFAULT_STATE: RuntimeState = {
  running: false,
  metadata: {},
};

/**
 * How many times one ntfy message is handed back for redelivery before it is
 * skipped. ntfy replays from the last message this node finished, so a failed
 * message returns on the reconnect; a few tries cover a transient failure, and
 * the bound keeps one bad message from holding its topic for as long as the
 * server caches it.
 */
// 4004 bad token, 4010-4012 bad shard or API version, 4013/4014 intents: reconnecting
// with the same credentials and settings is refused again.
const DISCORD_PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const NTFY_MESSAGE_ATTEMPTS = 3;
/** Failed-message counts kept at once; the oldest are forgotten first. */
const NTFY_MESSAGE_FAILURES_MAX = 256;
/** Consecutive stream reconnects before the topic reports it is not reading. */
const NTFY_RECONNECTS_BEFORE_DEGRADED = 3;

async function postSlackResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Slack response_url answered HTTP ${response.status}`);
  await response.arrayBuffer();
}

/** A server failure (5xx) or a capacity refusal (429): the request was not started. Other 4xx answers are policy outcomes. */
function isUnservedStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const SLACK_NOT_STARTED_TEXT = 'I could not start that request right now. Please try again in a moment.';

export class ChannelProviderRuntimeManager {
  private slackClient: SlackSocketModeClient | null = null;
  private discordClient: DiscordGatewayClient | null = null;
  /**
   * The start in progress for each socket surface, shared by concurrent callers,
   * and a generation that `stop()` bumps so a start still resolving tokens or
   * waiting on the socket knows it was cancelled.
   */
  private slackStart: Promise<ProviderRuntimeActionResult> | null = null;
  private discordStart: Promise<ProviderRuntimeActionResult> | null = null;
  private slackGeneration = 0;
  private discordGeneration = 0;
  /**
   * One live subscription per TOPIC, not one stream carrying all of them.
   *
   * ntfy will happily serve `topic-a,topic-b` down a single connection, and
   * that is what this used to do, but it makes the three topics one
   * indivisible consumer. Under per-surface leadership each topic is its own
   * surface with its own election, so this node can hold the agent topic while
   * a second machine holds the chat topic, and starting or stopping either has
   * to be possible without disturbing the other. A blanket consumer cannot
   * express that; a map of independent streams can.
   */
  private readonly ntfyAborts = new Map<string, AbortController>();
  /**
   * Why a topic is not being read, per topic. One status covers every topic,
   * so a failure kept on that status was erased by the next topic's start.
   */
  private readonly ntfyTopicErrors = new Map<string, string>();
  private readonly ntfyReconnects = new Map<string, number>();
  private readonly ntfyMessageFailures = new Map<string, number>();
  private socketLostHandler: ((kind: 'slack' | 'discord', reason: string, permanent?: boolean) => void) | null = null;
  private readonly state: Record<ProviderRuntimeSurface, RuntimeState> = {
    slack: { ...DEFAULT_STATE, metadata: {} },
    discord: { ...DEFAULT_STATE, metadata: {} },
    ntfy: { ...DEFAULT_STATE, metadata: {} },
  };

  constructor(private readonly deps: ProviderRuntimeManagerDeps) {}

  async start(
    surface: ProviderRuntimeSurface,
    options: ProviderRuntimeStartOptions = {},
  ): Promise<ProviderRuntimeActionResult> {
    if (surface === 'slack') return this.startSlack();
    if (surface === 'discord') return this.startDiscord();
    return this.startNtfy(options);
  }

  stop(surface: ProviderRuntimeSurface): ProviderRuntimeActionResult {
    if (surface === 'slack') {
      this.slackGeneration += 1;
      this.slackStart = null;
      this.slackClient?.stop();
      this.slackClient = null;
      this.markStopped('slack');
      return this.result('slack', true, 'Slack Socket Mode runtime stopped.');
    }
    if (surface === 'discord') {
      this.discordGeneration += 1;
      this.discordStart = null;
      this.discordClient?.stop();
      this.discordClient = null;
      this.markStopped('discord');
      return this.result('discord', true, 'Discord Gateway runtime stopped.');
    }
    for (const topic of [...this.ntfyAborts.keys()]) this.abortNtfyTopic(topic);
    this.ntfyTopicErrors.clear();
    this.ntfyReconnects.clear();
    this.markStopped('ntfy');
    return this.result('ntfy', true, 'ntfy JSON stream runtime stopped.');
  }

  // ── per-topic ntfy control ────────────────────────────────────────────────

  /**
   * The ntfy server these topics live on.
   *
   * Part of a topic's surface identity: the same topic name on two different
   * servers is two unrelated surfaces, and a node reading a self-hosted server
   * must never stand down for a node reading ntfy.sh.
   */
  ntfyBaseUrl(): string {
    return String(this.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh');
  }

  /** Every ntfy topic this node is configured to read. */
  ntfyTopics(): string[] {
    return this.resolveNtfyTopics();
  }

  /** Topics with a live subscription on this node right now. */
  runningNtfyTopics(): string[] {
    return [...this.ntfyAborts.keys()].sort();
  }

  /**
   * Subscribe to ONE topic. Idempotent per topic.
   *
   * `replayFromMs` is the last moment the previous holder of THIS topic was
   * heard from. ntfy keeps no per-subscriber cursor, so a takeover that
   * subscribed "from now" would silently lose everything published in the gap.
   */
  async startNtfyTopic(
    topic: string,
    options: ProviderRuntimeStartOptions = {},
  ): Promise<ProviderRuntimeActionResult> {
    if (this.ntfyAborts.has(topic)) {
      return this.result('ntfy', true, `ntfy topic subscription is already running.`);
    }
    const abort = new AbortController();
    this.ntfyAborts.set(topic, abort);
    let token: string | null;
    try {
      token = await this.resolveNtfyToken();
    } catch (error) {
      // Without this the topic stayed "already running" with no stream behind it.
      if (this.ntfyAborts.get(topic) === abort) this.ntfyAborts.delete(topic);
      const message = `the ntfy access token could not be resolved: ${summarizeError(error)}`;
      this.failNtfyTopic(topic, message);
      return this.result('ntfy', false, message);
    }
    if (abort.signal.aborted || this.ntfyAborts.get(topic) !== abort) {
      return this.result('ntfy', false, 'ntfy topic subscription start was cancelled by stop().');
    }
    this.ntfyTopicErrors.delete(topic);
    this.ntfyReconnects.delete(topic);
    const ntfy = new NtfyIntegration(this.ntfyBaseUrl(), token ?? undefined);
    const replayFromMs = options.replayFromMs ?? null;
    const since = replayFromMs === null
      ? createNtfyLiveSubscriptionSince()
      : createNtfyLiveSubscriptionSince(replayFromMs);
    this.markStarted('ntfy', {
      topics: this.runningNtfyTopics(),
      since,
      replayCachedMessages: replayFromMs !== null,
    });
    void ntfy.subscribeJsonStream(topic, (message) => this.handleNtfyMessage(message, topic), {
      since,
      signal: abort.signal,
      onReconnect: (error) => { this.noteNtfyReconnect(topic, error); },
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const message = summarizeError(error);
      if (this.ntfyAborts.get(topic) === abort) this.ntfyAborts.delete(topic);
      this.failNtfyTopic(topic, message);
      logger.warn('ChannelProviderRuntimeManager: ntfy stream failed', { topic, error: message });
    });
    return this.result('ntfy', true, 'ntfy JSON stream runtime started.');
  }

  /**
   * Drop ONE topic's subscription.
   *
   * Synchronous underneath, aborting the controller closes the stream before
   * this returns, which is what lets the RESIGN that follows a handoff be an
   * honest claim that this node has stopped reading the topic.
   */
  stopNtfyTopic(topic: string): ProviderRuntimeActionResult {
    this.abortNtfyTopic(topic);
    this.ntfyTopicErrors.delete(topic);
    this.ntfyReconnects.delete(topic);
    if (this.ntfyAborts.size === 0) this.markStopped('ntfy');
    else this.markStarted('ntfy', { topics: this.runningNtfyTopics() });
    return this.result('ntfy', true, 'ntfy topic subscription stopped.');
  }

  private abortNtfyTopic(topic: string): void {
    const abort = this.ntfyAborts.get(topic);
    if (!abort) return;
    abort.abort();
    this.ntfyAborts.delete(topic);
  }

  stopAll(): void {
    this.stop('slack');
    this.stop('discord');
    this.stop('ntfy');
  }

  status(surface: ProviderRuntimeSurface): ProviderRuntimeStatus {
    const state = this.state[surface]!;
    const topicErrors = surface === 'ntfy' && this.ntfyTopicErrors.size > 0
      ? [...this.ntfyTopicErrors].map(([topic, error]) => `${topic}: ${error}`).join('; ')
      : undefined;
    const lastError = state.lastError ?? topicErrors;
    return {
      surface,
      running: state.running,
      configured: this.isConfigured(surface),
      transport: surface === 'slack' ? 'socket-mode' : surface === 'discord' ? 'gateway' : 'json-stream',
      ...(state.lastStartedAt ? { lastStartedAt: state.lastStartedAt } : {}),
      ...(state.lastStoppedAt ? { lastStoppedAt: state.lastStoppedAt } : {}),
      ...(lastError ? { lastError } : {}),
      metadata: { ...state.metadata },
    };
  }

  private startSlack(): Promise<ProviderRuntimeActionResult> {
    if (this.slackClient?.isStarted) {
      return Promise.resolve(this.result('slack', true, 'Slack Socket Mode runtime is already running.'));
    }
    // A concurrent start shares the one in flight rather than building a second client.
    if (this.slackStart) return this.slackStart;
    const inFlight = this.runSlackStart(this.slackGeneration).finally(() => {
      if (this.slackStart === inFlight) this.slackStart = null;
    });
    this.slackStart = inFlight;
    return inFlight;
  }

  private async runSlackStart(generation: number): Promise<ProviderRuntimeActionResult> {
    const appToken = await this.resolveSlackAppToken();
    const botToken = await this.resolveSlackBotToken();
    if (!appToken) {
      this.markError('slack', 'Slack app-level token is required for Socket Mode.');
      return this.result('slack', false, 'Slack app-level token is required for Socket Mode.');
    }
    const webhookUrl = await this.deps.serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL;
    if (generation !== this.slackGeneration) return this.result('slack', false, 'Slack Socket Mode start was cancelled by stop().');
    const slack = new SlackIntegration(webhookUrl, botToken ?? undefined);
    const client: SlackSocketModeClient = new SlackSocketModeClient({
      appToken,
      integration: slack,
      onEnvelope: (envelope) => this.handleSlackEnvelope(envelope, slack),
      onClosed: (reason) => this.reportSocketLost('slack', reason, client),
    });
    // Reachable by stop() from here on, not only after start() resolves.
    this.slackClient = client;
    try {
      const connection = await client.start();
      if (this.slackClient !== client) {
        // stop() (or a newer start) took over while the socket was opening.
        client.stop();
        return this.result('slack', false, 'Slack Socket Mode start was cancelled by stop().');
      }
      if (!connection.ok) {
        this.slackClient = null;
        const message = connection.error ?? 'Slack Socket Mode connection failed.';
        if (generation === this.slackGeneration) this.markError('slack', message);
        return this.result('slack', false, message);
      }
      this.markStarted('slack', { socketMode: true });
      return this.result('slack', true, 'Slack Socket Mode runtime started.');
    } catch (error) {
      if (this.slackClient === client) this.slackClient = null;
      const message = summarizeError(error);
      // A start that stop() already cancelled must not repaint the newer state.
      if (generation === this.slackGeneration) this.markError('slack', message);
      return this.result('slack', false, message);
    }
  }

  private startDiscord(): Promise<ProviderRuntimeActionResult> {
    if (this.discordClient?.isStarted) {
      return Promise.resolve(this.result('discord', true, 'Discord Gateway runtime is already running.'));
    }
    if (this.discordStart) return this.discordStart;
    const inFlight = this.runDiscordStart(this.discordGeneration).finally(() => {
      if (this.discordStart === inFlight) this.discordStart = null;
    });
    this.discordStart = inFlight;
    return inFlight;
  }

  private async runDiscordStart(generation: number): Promise<ProviderRuntimeActionResult> {
    const botToken = await this.resolveDiscordBotToken();
    if (!botToken) {
      this.markError('discord', 'Discord bot token is required for Gateway runtime.');
      return this.result('discord', false, 'Discord bot token is required for Gateway runtime.');
    }
    const webhookUrl = await resolveSurfaceSecret(this.deps, 'discord', 'webhookUrl') ?? undefined;
    if (generation !== this.discordGeneration) return this.result('discord', false, 'Discord Gateway start was cancelled by stop().');
    const discord = new DiscordIntegration(webhookUrl, botToken);
    const client: DiscordGatewayClient = new DiscordGatewayClient({
      token: botToken,
      integration: discord,
      onDispatch: (dispatch) => this.handleDiscordDispatch(dispatch, discord),
      onClosed: (reason, code) => this.reportSocketLost('discord', reason, client, code !== undefined && DISCORD_PERMANENT_CLOSE_CODES.has(code)),
    });
    // Reachable by stop() from here on, not only after start() resolves.
    this.discordClient = client;
    try {
      const gateway = await client.start();
      if (this.discordClient !== client) {
        client.stop();
        return this.result('discord', false, 'Discord Gateway start was cancelled by stop().');
      }
      this.markStarted('discord', { gatewayUrl: gateway.url, shards: gateway.shards });
      return this.result('discord', true, 'Discord Gateway runtime started.');
    } catch (error) {
      if (this.discordClient === client) this.discordClient = null;
      const message = summarizeError(error);
      if (generation === this.discordGeneration) this.markError('discord', message);
      return this.result('discord', false, message);
    }
  }

  /**
   * Subscribe to every configured topic, each as its own stream.
   *
   * This is the path taken when leadership is switched off, the node reads
   * everything it is configured for. Under leadership the facade registers one
   * gate per topic instead, and each gate calls `startNtfyTopic` for the single
   * topic it won.
   */
  private async startNtfy(options: ProviderRuntimeStartOptions = {}): Promise<ProviderRuntimeActionResult> {
    const topics = this.resolveNtfyTopics();
    if (topics.length === 0) {
      this.markError('ntfy', 'ntfy topic is required for subscription runtime.');
      return this.result('ntfy', false, 'ntfy topic is required for subscription runtime.');
    }
    const results: Array<{ topic: string; result: ProviderRuntimeActionResult }> = [];
    for (const topic of topics) {
      results.push({ topic, result: await this.startNtfyTopic(topic, options) });
    }
    const failed = results.filter(({ result }) => !result.ok);
    if (failed.length === 0) return this.result('ntfy', true, 'ntfy JSON stream runtime started.');
    // Say which topics are not being read; `ok` stays false so a caller never
    // takes a partly started runtime for a running one.
    const started = results.length - failed.length;
    return this.result('ntfy', false,
      `ntfy started for ${started} of ${results.length} topics. Not reading: ${failed.map(({ topic, result }) => `${topic} (${result.message})`).join('; ')}`);
  }

  private async handleSlackEnvelope(envelope: SlackSocketModeEnvelope, slack: SlackIntegration): Promise<void> {
    if (!envelope.payload || typeof envelope.payload !== 'object') return;
    const payload = envelope.payload;
    await handleSlackSurfacePayload(payload, this.deps.buildSurfaceAdapterContext(), slack)
      .then(async (response) => {
        // Socket Mode acknowledged this envelope before it was handled, so the
        // adapter's answer has nowhere to travel. A refusal such as a spawn
        // failure (5xx) or a capacity refusal (429) is a failure of this surface;
        // a policy block (other 4xx) is an expected outcome, not one.
        if (response instanceof Response && isUnservedStatus(response.status)) {
          this.deps.ingressAlarm?.recordFailure('slack', `Slack request was refused (HTTP ${response.status})`);
        } else {
          this.deps.ingressAlarm?.recordSuccess('slack');
        }
        if (response instanceof Response) await this.answerSlackEnvelope(payload, response, slack);
      })
      .catch((error: unknown) => {
        const detail = summarizeError(error);
        logger.error('ChannelProviderRuntimeManager: Slack Socket Mode payload failed', { error: detail });
        this.deps.ingressAlarm?.recordFailure('slack', detail);
      });
  }

  /**
   * Deliver what the adapter said back to the person who asked. Webhook mode
   * sends the answer as the HTTP response; over Socket Mode that response is
   * discarded, so a slash command or button is answered through its
   * `response_url`, and a mention that could not be started is answered in its
   * channel. Nothing here may fail the envelope: the action already happened.
   */
  private async answerSlackEnvelope(payload: Record<string, unknown>, response: Response, slack: SlackIntegration): Promise<void> {
    try {
      let body: { text?: unknown; response_type?: unknown } = {};
      try { body = await response.clone().json() as typeof body; } catch { /* not a JSON answer */ }
      const unserved = isUnservedStatus(response.status);
      const text = typeof body.text === 'string' && body.text.trim()
        ? body.text
        : unserved ? SLACK_NOT_STARTED_TEXT : '';
      const responseUrl = typeof payload.response_url === 'string' ? payload.response_url : '';
      if (responseUrl) {
        if (!text || !responseUrl.startsWith('https://hooks.slack.com/')) return;
        const reply = { text, response_type: typeof body.response_type === 'string' ? body.response_type : 'ephemeral' };
        await (this.deps.postSlackResponse ?? postSlackResponseUrl)(responseUrl, reply);
        return;
      }
      const event = payload.event;
      if (!unserved || !event || typeof event !== 'object') return;
      const { channel } = event as { channel?: unknown };
      if (typeof channel !== 'string' || !channel) return;
      await slack.postMessage(channel, text);
    } catch (error) {
      logger.warn('ChannelProviderRuntimeManager: Slack answer could not be delivered', { error: summarizeError(error) });
    }
  }

  private async handleDiscordDispatch(dispatch: DiscordGatewayDispatch, discord: DiscordIntegration): Promise<void> {
    await handleDiscordGatewayDispatchPayload(dispatch, this.deps.buildSurfaceAdapterContext(), discord)
      .then((response) => {
        // Same rule as Slack: the adapter's refusal to start the request is this surface failing, not succeeding.
        if (response instanceof Response && isUnservedStatus(response.status)) {
          this.deps.ingressAlarm?.recordFailure('discord', `Discord request was refused (HTTP ${response.status})`);
        } else {
          this.deps.ingressAlarm?.recordSuccess('discord');
        }
      })
      .catch((error: unknown) => {
        const detail = summarizeError(error);
        logger.error('ChannelProviderRuntimeManager: Discord Gateway dispatch failed', { eventType: dispatch.t, error: detail });
        this.deps.ingressAlarm?.recordFailure('discord', detail);
      });
  }

  private async handleNtfyMessage(message: NtfyMessage, topic: string): Promise<void> {
    // ntfy opens every subscription with an `open` event: the stream is reading.
    if (message.event === 'open') {
      this.ntfyReconnects.delete(topic);
      this.ntfyTopicErrors.delete(topic);
      return;
    }
    if (message.event !== 'message') return;
    // WHICH MACHINE READ THIS MESSAGE.
    //
    // On a network where the same install runs on several machines, exactly
    // one of them should emit this line per message id. Two machines emitting
    // it for one id means both were reading the topic, which is the precise
    // failure leadership exists to prevent, and without this line there is no
    // way to tell that from the outside, because the surface pipeline that
    // runs afterwards leaves no per-message trace of the node that fed it.
    // The id and topic are recorded; the message body deliberately is not.
    logger.debug('ntfy: this node read an inbound message', {
      topic: message.topic ?? '(none)',
      messageId: message.id ?? '(none)',
    });
    let detail: string;
    let permanent = false;
    try {
      const response = await handleNtfySurfacePayload(message, this.deps.buildSurfaceAdapterContext());
      if (response.ok) {
        if (message.id) this.ntfyMessageFailures.delete(`${topic}\u0000${message.id}`);
        this.deps.ingressAlarm?.recordSuccess('ntfy');
        return;
      }
      detail = `ntfy dispatch failed (HTTP ${response.status})`;
      // A refusal (policy, malformed, unknown) says the same thing every time.
      permanent = response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 409 && response.status !== 429;
    } catch (error) {
      detail = summarizeError(error);
    }
    const key = message.id ? `${topic}\u0000${message.id}` : null;
    const attempt = key ? (this.ntfyMessageFailures.get(key) ?? 0) + 1 : NTFY_MESSAGE_ATTEMPTS;
    if (key && !permanent && attempt < NTFY_MESSAGE_ATTEMPTS) {
      // Throwing ends this stream; the reconnect resumes from the last message
      // finished, so this one is delivered again.
      this.ntfyMessageFailures.delete(key);
      this.ntfyMessageFailures.set(key, attempt);
      if (this.ntfyMessageFailures.size > NTFY_MESSAGE_FAILURES_MAX) {
        const oldest = this.ntfyMessageFailures.keys().next().value;
        if (oldest !== undefined) this.ntfyMessageFailures.delete(oldest);
      }
      logger.warn('ChannelProviderRuntimeManager: ntfy message dispatch failed; it will be delivered again', {
        topic, messageId: message.id, attempt, of: NTFY_MESSAGE_ATTEMPTS, error: detail,
      });
      throw new Error(detail);
    }
    if (key) this.ntfyMessageFailures.delete(key);
    logger.error('ChannelProviderRuntimeManager: ntfy message dispatch failed; skipping it so the topic keeps moving', {
      topic, messageId: message.id ?? '(none)', attempts: attempt, error: detail,
    });
    this.deps.ingressAlarm?.recordFailure('ntfy', detail);
  }

  /** A topic whose stream keeps dropping is not reading, whatever `running` says. */
  private noteNtfyReconnect(topic: string, error: unknown): void {
    const count = (this.ntfyReconnects.get(topic) ?? 0) + 1;
    this.ntfyReconnects.set(topic, count);
    if (count >= NTFY_RECONNECTS_BEFORE_DEGRADED) {
      this.ntfyTopicErrors.set(topic, `the stream has dropped ${count} times in a row and is reconnecting: ${summarizeError(error)}`);
    }
  }

  /** One topic's stream ended for good; the other topics keep their state. */
  private failNtfyTopic(topic: string, message: string): void {
    this.ntfyReconnects.delete(topic);
    this.ntfyTopicErrors.set(topic, message);
    if (this.ntfyAborts.size === 0) this.markError('ntfy', message);
  }

  // Every token is read through the setup schema's statement of where it lives
  // (channels/builtin/surface-secrets.ts), the same reader setup and delivery use.
  private async resolveSlackBotToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.deps, 'slack', 'primary');
  }

  private async resolveSlackAppToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.deps, 'slack', 'appToken');
  }

  private async resolveDiscordBotToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.deps, 'discord', 'primary');
  }

  private async resolveNtfyToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.deps, 'ntfy', 'primary');
  }

  private resolveNtfyTopics(): string[] {
    return [...resolveGoodVibesNtfyTopics({
      chatTopic: String(this.deps.configManager.get('surfaces.ntfy.chatTopic') || ''),
      agentTopic: String(this.deps.configManager.get('surfaces.ntfy.agentTopic') || ''),
      remoteTopic: String(this.deps.configManager.get('surfaces.ntfy.remoteTopic') || ''),
    }).all];
  }

  /**
   * Which Slack WORKSPACE this node reads, its team id, or null when that
   * cannot be established.
   *
   * The identity has to be real. Contesting Slack under a fixed placeholder
   * would make two nodes configured for two DIFFERENT workspaces fight over
   * one election, and the loser's workspace would go unanswered with nothing
   * to say why, the exact silent starvation per-surface elections exist to
   * remove.
   *
   * `auth.test` is a plain authenticated REST call: it opens no socket and
   * consumes no events, so the identity is settled BEFORE anything is
   * contested and there is never a window in which this node is reading
   * without having won. It doubles as the credential check, a token that
   * cannot identify its own workspace cannot read it either.
   */
  async resolveSlackWorkspaceId(): Promise<string | null> {
    const botToken = await this.resolveSlackBotToken();
    if (!botToken) return null;
    try {
      const identity = await new SlackIntegration(undefined, botToken).authTest(botToken);
      if (!identity.ok) return null;
      const teamId = typeof identity.team_id === 'string' ? identity.team_id.trim() : '';
      return teamId.length > 0 ? teamId : null;
    } catch (error) {
      logger.warn('ChannelProviderRuntimeManager: could not identify the Slack workspace', {
        error: summarizeError(error),
      });
      return null;
    }
  }

  /**
   * Which Discord APPLICATION this node reads, its bot user id, or null when
   * that cannot be established. Same argument as the Slack workspace above;
   * `/users/@me` opens no gateway and consumes no events.
   */
  async resolveDiscordApplicationId(): Promise<string | null> {
    const botToken = await this.resolveDiscordBotToken();
    if (!botToken) return null;
    try {
      const identity = await new DiscordIntegration(undefined, botToken).getCurrentBotUser(botToken);
      const id = typeof identity['id'] === 'string' ? identity['id'].trim() : '';
      return id.length > 0 ? id : null;
    } catch (error) {
      logger.warn('ChannelProviderRuntimeManager: could not identify the Discord application', {
        error: summarizeError(error),
      });
      return null;
    }
  }

  /** The identity of whichever socket surface this is, or null. */
  async resolveSocketSurfaceIdentity(kind: 'slack' | 'discord'): Promise<string | null> {
    return kind === 'slack' ? this.resolveSlackWorkspaceId() : this.resolveDiscordApplicationId();
  }

  /**
   * Learn that a socket dropped on its own.
   *
   * Late-bound because leadership is composed after the runtime: a node that
   * loses its Slack connection is a node that can no longer serve the Slack
   * surface, and it has to stand down rather than hold a workspace it is not
   * reading.
   */
  setSocketLostHandler(handler: (kind: 'slack' | 'discord', reason: string, permanent?: boolean) => void): void {
    this.socketLostHandler = handler;
  }

  private isConfigured(surface: ProviderRuntimeSurface): boolean {
    if (surface === 'slack') {
      const slackService = this.deps.serviceRegistry.get('slack');
      return Boolean(
        this.deps.configManager.get('surfaces.slack.appToken')
        || process.env.SLACK_APP_TOKEN
        || slackService?.appTokenKey
        || slackService?.appTokenRef,
      );
    }
    if (surface === 'discord') {
      const discordService = this.deps.serviceRegistry.get('discord');
      return Boolean(
        this.deps.configManager.get('surfaces.discord.botToken')
        || process.env.DISCORD_BOT_TOKEN
        || discordService?.tokenKey
        || discordService?.tokenRef,
      );
    }
    return this.resolveNtfyTopics().length > 0;
  }

  /**
   * A socket dropped without being asked to. Record it and tell leadership.
   *
   * The state is marked stopped first so a `/status` read during the stand-down
   * says what is true: this node is not reading that surface.
   */
  private reportSocketLost(kind: 'slack' | 'discord', reason: string, client?: SlackSocketModeClient | DiscordGatewayClient, permanent = false): void {
    // A stale client's late close must not unseat or mark-stopped a newer one.
    const current = kind === 'slack' ? this.slackClient : this.discordClient;
    if (client && current !== client) return;
    if (kind === 'slack') this.slackClient = null;
    else this.discordClient = null;
    // A permanent loss (a rejected token, a missing intent) keeps its reason in
    // the status, so /status says why this node is not reading the surface.
    this.markStopped(kind);
    if (permanent) this.markError(kind, reason);
    logger.warn(`${kind} connection dropped; this node can no longer read that surface`, {
      surface: kind,
      reason,
    });
    this.socketLostHandler?.(kind, reason, permanent);
  }

  private markStarted(surface: ProviderRuntimeSurface, metadata: Record<string, unknown>): void {
    this.state[surface] = {
      running: true,
      lastStartedAt: Date.now(),
      metadata,
    };
  }

  private markStopped(surface: ProviderRuntimeSurface): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastStoppedAt: Date.now(),
    };
  }

  private markError(surface: ProviderRuntimeSurface, error: string): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastError: error,
    };
  }

  private result(surface: ProviderRuntimeSurface, ok: boolean, message: string): ProviderRuntimeActionResult {
    return {
      ok,
      surface,
      status: this.status(surface),
      message,
    };
  }


}
