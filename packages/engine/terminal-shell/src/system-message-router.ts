import { runtimeEventOfNotice, type RuntimeEventProvenance } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import type { NoticeLevel, NoticeMeta } from '@goodvibes/engine/platform/platform/core';
import {
  classifySystemMessageKind,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageActivity,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes/engine/platform/platform/runtime/shell';
import { classifyNoise, foldProviderReplayLines, providerNameFromReplay, type NoiseGateDeps } from './system-message-noise.js';
export type { SystemMessageActivity, SystemMessageKind, SystemMessageTarget } from '@goodvibes/engine/platform/platform/runtime/shell';
export type SystemMessagePriority = 'high' | 'low';
export interface SystemMessageActivityFeed {
  /** `activity` is the Activity category the router states for the line; the feed stores it as given. */
  push(message: string, priority: SystemMessagePriority, activity: SystemMessageActivity): unknown;
}
/**
 * The Activity category of each leading `[Tag]` the products and the platform
 * write, keyed by the tag in lower case. An untagged line or an unlisted tag
 * is 'system'.
 */
export const SYSTEM_MESSAGE_TAG_ACTIVITIES: Readonly<Record<string, SystemMessageActivity>> = {
  agents: 'agent', agent: 'agent', 'delegated task': 'agent', wrfc: 'agent', contract: 'agent', replay: 'agent',
  schedule: 'schedule', schedules: 'schedule', wake: 'schedule', calendar: 'schedule', reminder: 'schedule',
  'occasion reminder': 'schedule', automation: 'schedule', routine: 'schedule', routines: 'schedule',
  delivery: 'delivery', channel: 'delivery', channels: 'delivery', telegram: 'delivery', slack: 'delivery',
  discord: 'delivery', ntfy: 'delivery', email: 'delivery', push: 'delivery', webhook: 'delivery',
  approval: 'security', permission: 'security', permissions: 'security', security: 'security',
  trust: 'security', auth: 'security', pairing: 'security',
  tool: 'tool', 'tool recovery': 'tool', exec: 'tool', shell: 'tool', mcp: 'tool', plugin: 'tool', hook: 'tool',
  model: 'status', provider: 'status', providers: 'status', local: 'status', scan: 'status', session: 'status',
  resume: 'status', recovery: 'status', compaction: 'status', daemon: 'status', 'connected host': 'status',
  remote: 'status', bridge: 'status', startup: 'status', setup: 'status', install: 'status', update: 'status',
  workspace: 'status', memory: 'status', health: 'status', status: 'status', terminal: 'status',
  voice: 'status', stop: 'status', rewind: 'status', revert: 'status',
};
/**
 * The Activity category of a line, from what its writer stated: the runtime
 * event it restates, a contract kind, else its leading tag. A table lookup;
 * no model reads the line, so an Activity row has its category when it appears.
 */
export function activityKindFor(
  message: string,
  kind?: SystemMessageKind | undefined,
  runtimeEvent?: RuntimeEventProvenance | undefined,
): SystemMessageActivity {
  const event = runtimeEvent?.type;
  if (event !== undefined) {
    if (event.startsWith('AGENT_') || event.startsWith('CONTRACT_')) return 'agent';
    if (event.startsWith('TURN_')) return 'status';
  }
  if (kind === 'contract') return 'agent';
  if (!message.startsWith('[')) return 'system';
  const end = message.indexOf(']');
  if (end <= 1) return 'system';
  const tag = message.slice(1, end).trim().toLowerCase();
  return Object.hasOwn(SYSTEM_MESSAGE_TAG_ACTIVITIES, tag) ? SYSTEM_MESSAGE_TAG_ACTIVITIES[tag]! : 'system';
}
export interface SystemMessageConversation {
  addEventNotice(message: string, runtimeEvent: RuntimeEventProvenance): void;
  addTypedSystemMessage(message: string, kind: SystemMessageKind, runtimeEvent?: RuntimeEventProvenance | undefined): void;
  addNotice(message: string, meta: NoticeMeta): void;
}
/**
 * The level each leading bracket tag a writer gives its line declares, keyed by
 * the tag in lower case. A writer that knows better passes the level itself; a
 * line with no listed tag is information. Code decides it: no model reads a notice.
 */
export const SYSTEM_MESSAGE_TAG_LEVELS: Readonly<Record<string, Exclude<NoticeLevel, 'info'>>> = {
  error: 'error',
  critical: 'error',
  warning: 'warning',
  warn: 'warning',
  failover: 'warning',
};
/** The level a writer declared: the one it passed, else the one its leading tag states, else information. */
export function declaredNoticeLevel(message: string, level?: NoticeLevel | undefined): NoticeLevel {
  if (level !== undefined) return level;
  if (!message.startsWith('[')) return 'info';
  const end = message.indexOf(']');
  if (end <= 1) return 'info';
  const tag = message.slice(1, end).trim().toLowerCase();
  return Object.hasOwn(SYSTEM_MESSAGE_TAG_LEVELS, tag) ? SYSTEM_MESSAGE_TAG_LEVELS[tag]! : 'info';
}
export interface SystemMessagePresentationPolicy {
  readonly typedConversation: boolean;
  readonly forceConversationPrefixes: readonly string[];
  readonly suppressCapturedOutput?: boolean;
  /**
   * The panel for a router with no activity feed: lines whose configured target
   * is `panel` or `both` go here. Bookkeeping (`activity`, `userAction`) never does.
   */
  readonly targetPanel?: SystemMessageActivityFeed | undefined;
  /** Every conversation notice is already recorded in the panel, so a line that reaches the conversation is not pushed to it again. */
  readonly conversationFeedsPanel?: boolean | undefined;
  /**
   * Whether the person set the target for this kind of line themselves (a
   * settings file or an override) rather than leaving the default. When given,
   * a high-priority line, one the person must see or act on, reaches the
   * conversation even where the default target is `panel`; a target the
   * person chose keeps it out unless it is an error or a warning.
   */
  readonly targetChosen?: ((kind: SystemMessageKind) => boolean) | undefined;
}
export class TerminalSystemMessageRouter<Feed extends SystemMessageActivityFeed = SystemMessageActivityFeed> {
  /** Buffered provider "from last session" replay lines, folded on a microtask. */
  private providerReplayBuffer: string[] = [];
  private providerReplayScheduled = false;
  constructor(
    private readonly conversation: SystemMessageConversation,
    private feed: Feed | null,
    private readonly getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    /** Noise-gate dependencies (WRFC terminal-chain lookup). See system-message-noise.ts. */
    private readonly noiseDeps: NoiseGateDeps = {},
    private readonly presentation: SystemMessagePresentationPolicy = { typedConversation: false, forceConversationPrefixes: [] },
  ) {}
  // ── Public API ────────────────────────────────────────────────────────────────
  routeTypedSystemMessage(
    message: string,
    priority: SystemMessagePriority,
    kind: SystemMessageKind,
    runtimeEvent?: RuntimeEventProvenance | undefined,
    level?: NoticeLevel | undefined,
  ): void {
    // Noise gate, keep first-run plumbing out of the Recent feed / transcript
    // while the information stays reachable via other live surfaces (activity
    // log, the Health tab, /model). Dropped noise is drop-from-the-feed, not delete.
    const verdict = classifyNoise(message, this.noiseDeps, this.presentation.suppressCapturedOutput);
    if (verdict.action === 'drop') return;
    if (verdict.action === 'foldProviderReplay') {
      this.bufferProviderReplay(message);
      return;
    }
    // A low-priority line that is only information (progress, a routine
    // success, bookkeeping) is not a notice: nothing in it needs the person, so
    // it goes to the activity feed where the host has one, else the activity
    // log, and never to the conversation or the count of notices. A low line
    // that declares a warning or an error (its writer's level or its runtime
    // event's) is still a notice.
    if (priority === 'low' && this.lowLevel(message, runtimeEvent, level) === 'info') {
      if (this.feed) this.feed.push(message, priority, activityKindFor(message, kind, runtimeEvent));
      else logger.info(message, { activity: activityKindFor(message, kind, runtimeEvent) });
      return;
    }
    const target = this.getTargetForKind(kind);
    const panel = this.feed ?? this.presentation.targetPanel ?? null;
    const delivery = resolveSystemMessageDelivery(target, panel !== null);
    const toConversation = delivery.toConversation
      || this.presentation.forceConversationPrefixes.some((prefix) => message.startsWith(prefix))
      || (priority === 'high' && this.mustShow(message, kind, level));
    if (delivery.toPanel && !(toConversation && this.presentation.conversationFeedsPanel === true)) {
      panel?.push(message, priority, activityKindFor(message, kind, runtimeEvent));
    }
    if (toConversation) {
      if (runtimeEvent === undefined) this.addDeclared(message, priority, this.presentation.typedConversation ? kind : undefined, level);
      // A line restating a runtime event takes that event's declared level.
      else if (this.presentation.typedConversation) this.conversation.addTypedSystemMessage(message, kind, runtimeEvent);
      else this.conversation.addEventNotice(message, runtimeEvent);
    }
  }
  /** The level a low line declares: its writer's, else its runtime event's, else its leading tag's; success counts as information. */
  private lowLevel(message: string, runtimeEvent: RuntimeEventProvenance | undefined, level: NoticeLevel | undefined): 'info' | 'warning' | 'error' {
    const declared = level ?? (runtimeEvent ? runtimeEventOfNotice(message, runtimeEvent)?.level : undefined) ?? declaredNoticeLevel(message);
    return declared === 'error' || declared === 'warning' ? declared : 'info';
  }
  /** A high-priority line shows on the main screen unless the person chose its target; then only an error or a warning does. */
  private mustShow(message: string, kind: SystemMessageKind, level: NoticeLevel | undefined): boolean {
    const chosen = this.presentation.targetChosen;
    if (chosen === undefined) return false;
    if (!chosen(kind)) return true;
    const declared = declaredNoticeLevel(message, level);
    return declared === 'error' || declared === 'warning';
  }
  /** Store the line with the level its writer declared, so the transcript and the notification history show it as given. */
  private addDeclared(message: string, priority: SystemMessagePriority, kind: SystemMessageKind | undefined, level: NoticeLevel | undefined): void {
    this.conversation.addNotice(message, { level: declaredNoticeLevel(message, level), priority, ...(kind ? { kind } : {}) });
  }
  /**
   * Buffer a provider "from last session" replay line and schedule a microtask
   * flush. The platform emits the whole persisted-provider burst synchronously, so a
   * single microtask captures the full burst and folds it to one quiet line.
   */
  private bufferProviderReplay(message: string): void {
    this.providerReplayBuffer.push(message);
    if (this.providerReplayScheduled) return;
    this.providerReplayScheduled = true;
    queueMicrotask(() => this.flushProviderReplay());
  }
  /**
   * Record the folded provider-replay summary to the activity log and reset the
   * buffer. The boot-only "— from last session" burst stays out of the Recent
   * feed; the persisted-provider set it summarizes is reachable on demand via
   * the Health tab and /model, and the fold line is logged for diagnosis. Only the
   * boot burst folds, mid-session provider-discovery lines never match
   * PROVIDER_REPLAY_RE, so they still reach the feed as live product signal.
   */
  flushProviderReplay(): void {
    this.providerReplayScheduled = false;
    if (this.providerReplayBuffer.length === 0) return;
    const summary = foldProviderReplayLines(this.providerReplayBuffer);
    const providerNames = this.providerReplayBuffer.map(providerNameFromReplay);
    this.providerReplayBuffer = [];
    logger.info(summary, { count: providerNames.length, providers: providerNames });
  }
  routeSystemMessage(
    message: string,
    priority: SystemMessagePriority,
    runtimeEvent?: RuntimeEventProvenance | undefined,
    level?: NoticeLevel | undefined,
  ): void {
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message), runtimeEvent, level);
  }
  /** High-priority shortcut, conversation + activity feed. `level` is the line's level when its tag does not state it. */
  high(message: string, level?: NoticeLevel | undefined): void {
    this.routeSystemMessage(message, 'high', undefined, level);
  }
  /** Direct response to a user action, or an offer waiting for the person's answer: always visible on the main screen once. */
  userAction(message: string, level?: NoticeLevel | undefined): void {
    this.addDeclared(message, 'high', undefined, level);
    this.feed?.push(message, 'high', activityKindFor(message));
  }
  /** Bookkeeping the person may look up but need not read now: the activity feed only, never the conversation. */
  activity(message: string): void {
    this.feed?.push(message, 'low', activityKindFor(message));
  }
  /** A local receipt bypasses ambient noise and delivery preferences. */
  userReceipt(message: string, level?: NoticeLevel | undefined): void {
    this.addDeclared(message, 'high', classifySystemMessageKind(message), level);
  }
  /** Low-priority shortcut: an information line goes to the activity feed or log only; a warning or error line is a notice. */
  low(message: string, runtimeEvent?: RuntimeEventProvenance | undefined, level?: NoticeLevel | undefined): void {
    this.routeSystemMessage(message, 'low', runtimeEvent, level);
  }
  contract(
    message: string,
    priority: SystemMessagePriority = 'high',
    runtimeEvent?: RuntimeEventProvenance | undefined,
    level?: NoticeLevel | undefined,
  ): void {
    this.routeTypedSystemMessage(message, priority, 'contract', runtimeEvent, level);
  }
  /** Returns the current activity feed reference. */
  getFeed(): Feed | null {
    return this.feed;
  }
  /**
   * Replace the feed reference after construction (late binding).
   * Pass null to detach.
   */
  setFeed(feed: Feed | null): void {
    this.feed = feed;
  }
}

/** Resolve targets from the live configuration rather than freezing it at bootstrap. */
export function configuredSystemMessageTarget(
  readUi: () => {
    readonly contractMessages: SystemMessageTarget;
    readonly operationalMessages: SystemMessageTarget;
    readonly systemMessages: SystemMessageTarget;
  },
) {
  return (kind: SystemMessageKind): SystemMessageTarget => {
    const ui = readUi();
    if (kind === 'contract') return ui.contractMessages;
    if (kind === 'operational') return ui.operationalMessages;
    return ui.systemMessages;
  };
}

/** The setting that holds the target for each kind of line. */
export type SystemMessageTargetKey = 'ui.contractMessages' | 'ui.operationalMessages' | 'ui.systemMessages';

/** Whether the person set a kind's target themselves, read live: one lookup per high-priority line. */
export function chosenSystemMessageTarget(isExplicitlySet: (key: SystemMessageTargetKey) => boolean) {
  return (kind: SystemMessageKind): boolean =>
    isExplicitlySet(kind === 'contract' ? 'ui.contractMessages' : kind === 'operational' ? 'ui.operationalMessages' : 'ui.systemMessages');
}
