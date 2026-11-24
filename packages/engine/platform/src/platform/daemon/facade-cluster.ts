/**
 * facade-cluster.ts, leadership gating for the daemon's INBOUND consumers,
 * one gate per surface.
 *
 * Several things start listening when the daemon comes up: the Telegram
 * ingress supervisor, a subscription per ntfy topic, the Slack Socket Mode
 * connection, the Discord Gateway. Each is registered here as its OWN gate on
 * the cluster coordinator instead of being started directly, so on a network
 * where this install runs more than once exactly one node reads each of them,
 * and different nodes may read different ones.
 *
 * That per-surface split is the whole point. The previous shape registered one
 * gate for "the provider runtime" covering Slack, Discord and every ntfy topic
 * together, which meant a node either read all of them or none. A laptop with
 * a bot token and a desktop with only a topic could not divide the work, and
 * whichever won took surfaces it had no credential for.
 *
 * A gate is registered only for a surface this node can ACTUALLY serve: the
 * surface is enabled in config and its credential resolves. That is what stops
 * a node winning an election for something it cannot read, which would starve
 * the node that could.
 *
 * What is deliberately NOT gated: outbound delivery, sessions, the control
 * plane, the HTTP listener, watchers, triggers, and every other daemon
 * subsystem. A standby node is a fully functional daemon that simply is not the
 * one reading a particular inbox, it can still send, still serve the web UI,
 * still run agents. Gating anything else would turn "we are not the reader"
 * into "we are degraded", which is not what leadership means here.
 *
 * A host that gates inbound consumers of its own passes a coordinator in
 * (`DaemonConfig.clusterCoordinator`). It MUST be reused rather than
 * supplemented: two coordinators in one process would be two nodes in the
 * group, and one would gate consumers the other owns. The goodvibes-tui daemon
 * does exactly this so its own inbox poller rides the same leadership.
 */
import {
  ClusterCoordinator,
  clusterRoleGate,
  inboxSurface,
  ntfySurface,
  readClusterSettings,
  telegramSurface,
} from '../cluster/index.js';
import { SocketSurfaceSupervisor } from './facade-cluster-sockets.js';
import { AFTER_REPLY } from './http/cluster-group-routes.js';
import type { ClusterConsumerGate, ClusterSurfaceKey } from '../cluster/index.js';
import type { BuiltinChannelRuntime, ChannelProviderRuntimeManager } from '../channels/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { DaemonConfig } from './types.js';
import type { DaemonFacadeCollaborators, ResolvedDaemonFacadeRuntime } from './facade-types.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export { ClusterCoordinator } from '../cluster/index.js';

/**
 * One ntfy topic as a leadership gate.
 *
 * `replayFromMs` is threaded into the subscription because ntfy has no
 * server-side per-subscriber cursor: a takeover that subscribed "from now"
 * would drop everything published between the previous holder's last heartbeat
 * and this start. Telegram needs no equivalent, its backlog lives on
 * Telegram's servers and the persisted offset already covers the gap.
 *
 * A start the runtime refuses (its access token cannot be read) rejects, so
 * the election knows this node is not reading the topic and stands it down;
 * a refusal caused by this gate's own stop is not a failure.
 */
function ntfyTopicGate(
  providerRuntime: ChannelProviderRuntimeManager,
  baseUrl: string,
  topic: string,
): ClusterConsumerGate {
  let generation = 0;
  return {
    id: `ntfy-topic:${topic}`,
    surface: ntfySurface(baseUrl, topic),
    start: async (context) => {
      const attempt = ++generation;
      const result = await providerRuntime.startNtfyTopic(topic, { replayFromMs: context.replayFromMs });
      if (result.ok || attempt !== generation) return;
      throw new Error(`ntfy did not start reading the topic: ${result.message}`);
    },
    stop: async () => {
      generation += 1;
      providerRuntime.stopNtfyTopic(topic);
    },
  };
}

/**
 * Slack Socket Mode and the Discord Gateway as gates, under the surface
 * identity the provider itself reported.
 *
 * The discriminator is the real workspace or application id, resolved before
 * anything is contested, see facade-cluster-sockets.ts for why a placeholder
 * would starve one of two differently-configured workspaces.
 *
 * A start the provider refuses (no socket opened) rejects, so the election
 * knows this node is not reading the workspace, and `onStartFailed` hands the
 * surface on the same way a dropped socket does. A refusal caused by this
 * gate's own stop is not a failure and is left alone.
 */
export function socketProviderGate(
  providerRuntime: Pick<ChannelProviderRuntimeManager, 'start' | 'stop'>,
  kind: 'slack' | 'discord',
  surface: ClusterSurfaceKey,
  onStartFailed: (message: string) => void,
): ClusterConsumerGate {
  let generation = 0;
  return {
    id: `${kind}-socket`,
    surface,
    start: async () => {
      const attempt = ++generation;
      const result = await providerRuntime.start(kind);
      if (result.ok || attempt !== generation) return;
      // Deferred: withdrawing the gate from inside its own start would
      // re-enter the registry while it is still starting this gate.
      setTimeout(() => onStartFailed(result.message), 0);
      throw new Error(`${kind} did not connect: ${result.message}`);
    },
    stop: async () => {
      generation += 1;
      providerRuntime.stop(kind);
    },
  };
}

/**
 * Telegram ingress as a leadership gate.
 *
 * `stopIngress()` does not resolve until the in-flight long poll has settled
 * and its offset has been committed, which is the property the ordered handoff
 * depends on: the successor is told to start only after this promise resolves.
 */
function telegramIngressGate(
  builtinChannels: BuiltinChannelRuntime,
  surface: ClusterSurfaceKey,
): ClusterConsumerGate {
  return {
    id: 'telegram-ingress',
    surface,
    start: async () => {
      await builtinChannels.startIngress();
    },
    stop: async () => {
      await builtinChannels.stopIngress();
    },
  };
}

/** The one answer when the daemon cannot restart itself to finish a join. */
export const RESTART_BY_HAND_TO_JOIN = 'Restart this daemon to finish joining: it was started by hand, so GoodVibes cannot restart it.';
/** The same answer for the other group actions kept for the restart. */
export const RESTART_BY_HAND_TO_FINISH = 'Restart this daemon to finish it: it was started by hand, so GoodVibes cannot restart it.';

type GroupVerbs = import('./http/cluster-group-routes.js').ClusterGroupVerbs;
type RestartOutcome = {
  readonly outcome: 'restarting' | 'by-hand' | 'failed';
  readonly detail?: string | undefined;
  /** Begins the restart; run once the reply is written (the route does it, AFTER_REPLY). */
  readonly begin?: (() => void) | undefined;
};

/**
 * The group verbs with the restart a kept action needs: a join, removal, key
 * rotation, rename, publish or accept asked for while sharing was off (stored
 * as pending, `cluster.enabled` set) restarts the daemon through its service,
 * and the action finishes at the next start, where the owner is told once. A
 * daemon started by hand answers that it must be restarted by hand and keeps
 * the action for its next start. The restart begins after the reply is
 * written: the service's stop closes every open connection, this one too.
 */
export function withRestartForPendingGroupAction(verbs: GroupVerbs, restart: () => RestartOutcome): GroupVerbs {
  const finish = async <T extends { readonly pending?: true }>(
    result: import('../cluster/index.js').GroupOperationResult<T>,
    join: boolean,
  ): Promise<import('../cluster/index.js').GroupOperationResult<T>> => {
    if (!result.ok || result.data.pending !== true) return result;
    const restarted = restart();
    const message = restarted.outcome === 'restarting'
      ? join
        ? 'Sharing is on. The daemon is restarting to bring the group up; it joins at its next start and tells you once it has.'
        : 'Sharing is on. The daemon is restarting to bring the group up; this finishes at its next start and you are told once it has.'
      : restarted.outcome === 'by-hand'
        ? (join ? RESTART_BY_HAND_TO_JOIN : RESTART_BY_HAND_TO_FINISH)
        : `Sharing is on and this is kept, but the daemon could not restart itself (${restarted.detail ?? 'no reason given'}). Restart this daemon to finish it.`;
    const answer: import('../cluster/index.js').GroupOperationResult<T> = { ok: true, data: { ...result.data, restart: restarted.outcome, warning: message } };
    return restarted.begin ? Object.assign(answer, { [AFTER_REPLY]: restarted.begin }) : answer;
  };
  return {
    ...verbs,
    join: async (input) => finish(await verbs.join(input), true),
    forget: async (nodeId, options) => finish(await verbs.forget(nodeId, options), false),
    rotate: async (input) => finish(await verbs.rotate(input), false),
    rename: async (name, options) => finish(await verbs.rename(name, options), false),
    publish: async (path, options) => finish(await verbs.publish(path, options), false),
    accept: async (path, options) => finish(await verbs.accept(path, options), false),
  };
}

/**
 * Build (or adopt) the coordinator, and tell it how to find out what this node
 * can serve.
 *
 * The surfaces are registered through `onPrepare` rather than here, because
 * deciding whether a surface is servable means RESOLVING its credential and
 * this function is synchronous. `onPrepare` runs that work at `start()`, ahead
 * of the first boot probe, so every servable surface is in its own first
 * election and no unresolvable one is contested at all.
 */
export function buildDaemonClusterCoordinator(
  config: DaemonConfig,
  runtime: ResolvedDaemonFacadeRuntime,
  collaborators: DaemonFacadeCollaborators,
): ClusterCoordinator {
  const coordinator = config.clusterCoordinator ?? new ClusterCoordinator({
    settings: readClusterSettings(runtime.configManager, runtime.runtimeServices?.secretsManager),
    version: VERSION,
    // Alongside the Telegram poll cursor: node identity is per-surface state
    // and must not leak across surface roots.
    stateDirectory: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'cluster'),
    logger,
  });
  // The LAN group verbs (/api/cluster/*), when the host composed a group
  // runtime. Wired here rather than in facade.ts because this is already the
  // one place the daemon's cluster wiring lives.
  if (config.clusterGroupVerbs) collaborators.httpRouter.setClusterGroupVerbs(config.clusterGroupVerbs);
  // The work a group runs once (cluster/roles.ts): the scheduled check-in and
  // the occasion reminders ask the runtime's role holder before they act, and
  // it answers from this coordinator. Every machine contests both roles; the
  // election gives each to one of them and moves it when that one stops.
  runtime.runtimeServices.clusterRoles?.bind(coordinator);
  if (coordinator.enabled) {
    coordinator.register(clusterRoleGate('checkin'));
    coordinator.register(clusterRoleGate('occasions'));
    // The group's schedules, reminders and url watchers (on its record) run on
    // the machine holding this role: taking it arms their timers from the
    // record, giving it up drops them before the next holder takes over.
    const roles = runtime.runtimeServices.clusterRoles;
    coordinator.register(clusterRoleGate('automation',
      async () => { roles?.announce('automation', true); },
      async () => { roles?.announce('automation', false); }));
  }
  // Per-surface registration, which supersedes the whole-node gates: the
  // provider runtime, Telegram ingress, and the consumer-conflict route are all
  // registered per surface inside registerDaemonClusterSurfaces, so a conflict
  // over one bot token no longer stands this node down from every other
  // surface. It runs through onPrepare because deciding whether a surface is
  // servable means resolving its credential, and this function is synchronous.
  coordinator.onPrepare(() => registerDaemonClusterSurfaces(coordinator, runtime, collaborators));
  return coordinator;
}

/**
 * One inbound surface the operator enabled cannot be served, so this node will
 * not contest it and will not read it.
 *
 * This is the single most expensive state the daemon can be in, the config
 * reads correct, the process is healthy, and messages disappear, so it is
 * stated at ERROR with the operator's next action in it, not left to a status
 * endpoint nobody queries. It matters more under leadership than it did
 * before: a node that quietly declines a surface looks exactly like a node
 * that correctly lost its election.
 */
function reportInert(surface: string, action: string): void {
  logger.error(`${surface} is enabled but this node will NOT receive its messages`, { surface, action });
}

/**
 * Inbound mail as a leadership gate.
 *
 * Clustering defaults off, but when the owner opts in, two nodes both holding
 * an IDLE connection to the same mailbox would both fetch and both notify,
 * the same message announced twice by a capability whose entire value is being
 * told exactly once. `stopInboundMail()` does not resolve until the source has
 * genuinely stopped and released its connection, which is the property the
 * ordered handoff depends on.
 *
 * The surface is `inbox`, discriminated by account and mailbox: two mailboxes
 * on one machine are two elections, and a node watching the signup alias must
 * not stand down for a node watching the owner's personal mailbox.
 */
function inboundMailGate(
  builtinChannels: BuiltinChannelRuntime,
  surface: ClusterSurfaceKey,
): ClusterConsumerGate {
  return {
    id: 'email-inbound',
    surface,
    start: async () => {
      await builtinChannels.startInboundMail();
    },
    stop: async () => {
      await builtinChannels.stopInboundMail();
    },
  };
}

/**
 * The mailbox reader, registered whenever a supervisor was composed for it.
 *
 * The reader is the one thing that reads this mailbox, for inbound notices
 * and for the inbox alike, so its surface is the one placement rule for both:
 * the node that holds it reads, and no other node signs in. A node holding it
 * with notices off and no inbox attached reads nothing until one of them wants
 * the mail; the supervisor decides that, not the election.
 */
function registerInboundMailSurface(
  coordinator: ClusterCoordinator,
  config: ConfigManager,
  collaborators: DaemonFacadeCollaborators,
): void {
  const mailbox = collaborators.builtinChannels.inboundMailIdentity();
  if (mailbox === null) {
    if (!config.get('surfaces.email.inbound.enabled')) return;
    reportInert('email-inbound', 'inbound mail is enabled and this build composed no inbound-mail '
      + 'supervisor, so no mailbox is watched; the embedder must pass inboundMail to '
      + 'BuiltinChannelRuntime');
    return;
  }
  coordinator.register(inboundMailGate(
    collaborators.builtinChannels,
    inboxSurface(`email:${mailbox.account}:${mailbox.mailbox}`),
  ));
}

/**
 * Which election keys each received channel is contested under, so channel
 * health can tell a standby that is not reading by design from a reader that
 * died. A channel with no key here was never contested and reports its own
 * state; so does every channel before the coordinator runs.
 */
class ContestedSurfaces {
  private readonly keys = new Map<string, Map<string, ClusterSurfaceKey>>();

  add(channel: 'telegram' | 'slack' | 'discord' | 'ntfy', id: string, surface: ClusterSurfaceKey): void {
    const list = this.keys.get(channel) ?? new Map<string, ClusterSurfaceKey>();
    list.set(id, surface);
    this.keys.set(channel, list);
  }

  remove(channel: 'telegram' | 'slack' | 'discord' | 'ntfy', id: string): void {
    this.keys.get(channel)?.delete(id);
  }

  isResponsible(coordinator: ClusterCoordinator, channel: string): boolean {
    const keys = this.keys.get(channel);
    if (!coordinator.running || keys === undefined || keys.size === 0) return true;
    return [...keys.values()].some((surface) => coordinator.holdsSurface(surface));
  }
}

/** The settings and credentials whose change can make a surface servable or not. */
const SURFACE_KEYS = [
  'surfaces.telegram.enabled',
  'surfaces.telegram.botToken',
  'surfaces.ntfy.enabled',
  'surfaces.ntfy.baseUrl',
  'surfaces.ntfy.chatTopic',
  'surfaces.ntfy.agentTopic',
  'surfaces.ntfy.remoteTopic',
  'surfaces.slack.enabled',
  'surfaces.slack.botToken',
  'surfaces.discord.enabled',
  'surfaces.discord.botToken',
] as const;

/**
 * Keeps this node's registered consumers in line with what it can serve NOW.
 *
 * Registration used to run once, at start, so a surface enabled or given a
 * credential afterwards did nothing until a restart, and the status said only
 * that the composition root never started it. Every step here is idempotent:
 * it registers what became servable, withdraws what no longer is (a topic
 * renamed, a surface switched off, a bot token swapped for another bot's), and
 * leaves the rest alone, so it can run at every start and on every change.
 */
class DaemonSurfaceRegistrar {
  private readonly contested = new ContestedSurfaces();
  private readonly ntfy = new Map<string, () => void>();
  private ntfyInertReported = false;
  private readonly sockets = new Map<'slack' | 'discord', SocketSurfaceSupervisor>();
  private telegram: { readonly botId: string; readonly withdraw: () => void } | null = null;
  private telegramInertReported = false;
  private inboundMailRegistered = false;
  private watching = false;
  private reconciling: Promise<void> | null = null;
  private again: { refresh: boolean } | null = null;

  constructor(
    private readonly coordinator: ClusterCoordinator,
    private readonly runtime: ResolvedDaemonFacadeRuntime,
    private readonly collaborators: DaemonFacadeCollaborators,
  ) {}

  /** Register what is servable now, then keep doing so as settings and credentials change. */
  async start(): Promise<void> {
    this.collaborators.builtinChannels.setSurfaceResponsibility(
      (surface) => this.contested.isResponsible(this.coordinator, surface),
    );
    // A topic whose stream the server refused for good is not being read here,
    // so this node stops contesting it; the next reconcile (a settings or
    // secret change) contests it again.
    this.collaborators.providerRuntime.setNtfyTopicLostHandler((topic, reason) => { this.onNtfyTopicLost(topic, reason); });
    await this.reconcile(false);
    if (!this.inboundMailRegistered) {
      this.inboundMailRegistered = true;
      registerInboundMailSurface(this.coordinator, this.runtime.configManager, this.collaborators);
    }
    this.watch();
  }

  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    const config = this.runtime.configManager;
    for (const key of SURFACE_KEYS) {
      // A changed bot token may name a different workspace or bot, so those
      // re-identify what is already registered; the rest only add and withdraw.
      config.subscribe(key, () => { this.request(key.endsWith('botToken')); });
    }
    // The token usually lives in the secret store, which config does not see.
    const secrets = this.runtime.runtimeServices?.secretsManager;
    if (secrets && typeof secrets.onDidChange === 'function') {
      secrets.onDidChange(() => { this.request(false); });
    }
  }

  /** One reconcile at a time; a change that lands mid-run earns exactly one more. */
  private request(refresh: boolean): void {
    // A setting or credential change after the daemon stopped must not open consumers nobody will stop.
    if (!this.coordinator.running) return;
    if (this.reconciling) {
      this.again = { refresh: refresh || (this.again?.refresh ?? false) };
      return;
    }
    void this.reconcile(refresh);
  }

  private reconcile(refresh: boolean): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const work = this.reconcileOnce(refresh).catch((error: unknown) => {
      logger.error('cluster: could not bring the inbound consumers in line with the settings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.reconciling = null;
      const next = this.again;
      this.again = null;
      if (next && this.coordinator.running) void this.reconcile(next.refresh);
    });
    this.reconciling = work;
    return work;
  }

  private async reconcileOnce(refresh: boolean): Promise<void> {
    await this.reconcileNtfy();
    await this.reconcileSockets(refresh);
    await this.reconcileTelegram();
  }

  private async reconcileNtfy(): Promise<void> {
    const config = this.runtime.configManager;
    const providerRuntime = this.collaborators.providerRuntime;
    const wanted = new Map<string, { topic: string; baseUrl: string }>();
    if (config.get('surfaces.ntfy.enabled')) {
      const baseUrl = providerRuntime.ntfyBaseUrl();
      // Each topic name is read from the secret store its setting names (an unset one is generated there).
      const topics = await providerRuntime.ntfyTopics();
      if (topics.length === 0) {
        if (!this.ntfyInertReported) {
          this.ntfyInertReported = true;
          reportInert('ntfy', 'no ntfy topic resolved; set surfaces.ntfy.agentTopic (and optionally chatTopic / remoteTopic)');
        }
      } else {
        this.ntfyInertReported = false;
      }
      for (const topic of topics) wanted.set(`${baseUrl}\n${topic}`, { topic, baseUrl });
    } else {
      this.ntfyInertReported = false;
    }
    for (const [id, withdraw] of [...this.ntfy]) {
      if (wanted.has(id)) continue;
      this.ntfy.delete(id);
      this.contested.remove('ntfy', id);
      withdraw();
    }
    for (const [id, { topic, baseUrl }] of wanted) {
      if (this.ntfy.has(id)) continue;
      const gate = ntfyTopicGate(this.collaborators.providerRuntime, baseUrl, topic);
      this.contested.add('ntfy', id, gate.surface);
      this.ntfy.set(id, this.coordinator.register(gate));
    }
  }

  /** Withdraw the gate of a topic whose stream ended for good, and say why it is not read. */
  private onNtfyTopicLost(topic: string, reason: string): void {
    let withdrew = false;
    for (const [id, withdraw] of [...this.ntfy]) {
      if (id.slice(id.indexOf('\n') + 1) !== topic) continue;
      this.ntfy.delete(id);
      this.contested.remove('ntfy', id);
      withdraw();
      withdrew = true;
    }
    if (withdrew) {
      reportInert('ntfy', `the ntfy server refused the topic's stream (${reason}); this node stopped contesting it. `
        + 'Fix the topic or its access token; it is contested again when an ntfy setting or a stored secret changes');
    }
  }

  /**
   * Slack and Discord are contested under the identity the provider reports,
   * never under a placeholder, a placeholder would put two different
   * workspaces into one election and starve whichever lost.
   */
  private async reconcileSockets(refresh: boolean): Promise<void> {
    const config = this.runtime.configManager;
    const providerRuntime = this.collaborators.providerRuntime;
    for (const kind of ['slack', 'discord'] as const) {
      const enabled = Boolean(config.get(`surfaces.${kind}.enabled` as Parameters<ConfigManager['get']>[0]));
      const existing = this.sockets.get(kind);
      if (!enabled) {
        if (existing) {
          existing.dispose();
          this.sockets.delete(kind);
          this.contested.remove(kind, kind);
        }
        continue;
      }
      if (existing) {
        await (refresh ? existing.refresh() : existing.begin());
        this.noteSocketSurface(kind, existing);
        continue;
      }
      const supervisor: SocketSurfaceSupervisor = new SocketSurfaceSupervisor({
        kind,
        resolveIdentity: () => providerRuntime.resolveSocketSurfaceIdentity(kind),
        // A start that never connects is handled like a socket that dropped: the
        // gate is withdrawn, a RESIGN lets another node try, and this one tries
        // again later.
        // The contested record lives and dies with the registration: whatever
        // withdraws the gate (a lost socket, a refresh, dispose) clears it, so
        // channel health never reports a peer serving a surface nobody contests.
        register: (surface) => {
          this.contested.add(kind, kind, surface);
          const withdraw = this.coordinator.register(socketProviderGate(providerRuntime, kind, surface,
            (message) => { this.sockets.get(kind)?.onSocketLost(message); }));
          return () => {
            this.contested.remove(kind, kind);
            withdraw();
          };
        },
        isRunning: () => this.coordinator.running,
        reportInert,
        logger,
      });
      this.sockets.set(kind, supervisor);
      await supervisor.begin();
    }
    // A dropped socket means this node can no longer read that workspace, so
    // it stands down rather than holding a surface it is not serving.
    if (this.sockets.size > 0) {
      providerRuntime.setSocketLostHandler((kind, reason, permanent) => {
        this.sockets.get(kind)?.onSocketLost(reason, permanent);
      });
    }
  }

  /** A surface that was re-identified is contested under its new name only. */
  private noteSocketSurface(kind: 'slack' | 'discord', supervisor: SocketSurfaceSupervisor): void {
    const surface = supervisor.contestedSurface;
    if (surface) this.contested.add(kind, kind, surface);
    else this.contested.remove(kind, kind);
  }

  /** Telegram ingress, registered only when this node can actually serve it. */
  private async reconcileTelegram(): Promise<void> {
    const config = this.runtime.configManager;
    if (!config.get('surfaces.telegram.enabled')) {
      this.telegramInertReported = false;
      this.withdrawTelegram();
      return;
    }
    const botId = await this.collaborators.builtinChannels.resolveServableTelegramBotId();
    if (!botId) {
      this.withdrawTelegram();
      if (!this.telegramInertReported) {
        this.telegramInertReported = true;
        reportInert('telegram', 'no Telegram bot token resolved; set surfaces.telegram.botToken '
          + '(a goodvibes://secrets/... reference is fine) or the TELEGRAM_BOT_TOKEN environment variable');
      }
      return;
    }
    this.telegramInertReported = false;
    if (this.telegram?.botId === botId) return;
    // A token for another bot is another surface; the old one is stood down first.
    this.withdrawTelegram();
    const surface = telegramSurface(botId);
    this.contested.add('telegram', 'telegram', surface);
    this.telegram = {
      botId,
      withdraw: this.coordinator.register(telegramIngressGate(this.collaborators.builtinChannels, surface)),
    };
    // Late-bound because the runtime is built before the coordinator exists: a
    // Telegram 409 naming another consumer has to reach leadership, not a log.
    // Routed at the Telegram surface specifically, a conflict over one bot
    // token is no reason to give up an unrelated ntfy topic.
    this.collaborators.builtinChannels.setConsumerConflictHandler(
      (detail) => this.coordinator.reportConsumerConflict(detail, surface),
    );
  }

  private withdrawTelegram(): void {
    if (!this.telegram) return;
    this.telegram.withdraw();
    this.telegram = null;
    this.contested.remove('telegram', 'telegram');
  }
}

const registrars = new WeakMap<ClusterCoordinator, DaemonSurfaceRegistrar>();

/** Register a gate for every inbound surface this node can actually serve, and keep it so. */
export async function registerDaemonClusterSurfaces(
  coordinator: ClusterCoordinator,
  runtime: ResolvedDaemonFacadeRuntime,
  collaborators: DaemonFacadeCollaborators,
): Promise<void> {
  let registrar = registrars.get(coordinator);
  if (!registrar) {
    registrar = new DaemonSurfaceRegistrar(coordinator, runtime, collaborators);
    registrars.set(coordinator, registrar);
  }
  await registrar.start();
}
