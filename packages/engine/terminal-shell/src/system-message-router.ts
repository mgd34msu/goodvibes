import type { RuntimeEventProvenance } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { NoticeLevel, NoticeMeta } from '@goodvibes-jev/engine/platform/platform/core';
import {
  classifySystemMessageKind,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { classifyNoise, foldProviderReplayLines, providerNameFromReplay, type NoiseGateDeps } from './system-message-noise.js';
export type { SystemMessageKind, SystemMessageTarget } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
export type SystemMessagePriority = 'high' | 'low';
export interface SystemMessageActivityFeed {
  push(message: string, priority: SystemMessagePriority): unknown;
}
export interface SystemMessageConversation {
  addSystemMessage(message: string, runtimeEvent?: RuntimeEventProvenance | undefined): void;
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
    // log, /health, /model). Dropped noise is drop-from-the-feed, not delete.
    const verdict = classifyNoise(message, this.noiseDeps, this.presentation.suppressCapturedOutput);
    if (verdict.action === 'drop') return;
    if (verdict.action === 'foldProviderReplay') {
      this.bufferProviderReplay(message);
      return;
    }
    const target = this.getTargetForKind(kind);
    const delivery = resolveSystemMessageDelivery(target, this.feed !== null);
    if (delivery.toPanel) {
      this.feed?.push(message, priority);
    }
    if (delivery.toConversation || this.presentation.forceConversationPrefixes.some((prefix) => message.startsWith(prefix))) {
      if (runtimeEvent === undefined) this.addDeclared(message, priority, this.presentation.typedConversation ? kind : undefined, level);
      // A line restating a runtime event takes that event's declared level.
      else if (this.presentation.typedConversation) this.conversation.addTypedSystemMessage(message, kind, runtimeEvent);
      else this.conversation.addSystemMessage(message, runtimeEvent);
    }
  }
  /** Store the line with the level its writer declared, so the transcript and the toast show it as given. */
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
   * /health and /model, and the fold line is logged for diagnosis. Only the
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
  /** Direct response to a user action, always visible on the main screen once. */
  userAction(message: string, level?: NoticeLevel | undefined): void {
    this.addDeclared(message, 'high', undefined, level);
    this.feed?.push(message, 'high');
  }
  /** Bookkeeping the person may look up but need not read now: the activity feed only, never the conversation. */
  activity(message: string): void {
    this.feed?.push(message, 'low');
  }
  /** A local receipt bypasses ambient noise and delivery preferences. */
  userReceipt(message: string, level?: NoticeLevel | undefined): void {
    this.addDeclared(message, 'high', classifySystemMessageKind(message), level);
  }
  /** Low-priority shortcut, activity feed only. */
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
