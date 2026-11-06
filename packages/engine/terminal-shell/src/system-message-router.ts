import type { RuntimeEventProvenance } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { classifyNoise, foldProviderReplayLines, providerNameFromReplay, type NoiseGateDeps } from './system-message-noise.js';
export type { SystemMessageKind, SystemMessageTarget } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
export type SystemMessagePriority = 'high' | 'low';
export interface SystemMessageActivityFeed {
  push(message: string, priority: SystemMessagePriority): unknown;
}
export interface SystemMessageConversation {
  addSystemMessage(message: string, runtimeEvent?: RuntimeEventProvenance | undefined): void;
  addTypedSystemMessage(message: string, kind: SystemMessageKind, runtimeEvent?: RuntimeEventProvenance | undefined): void;
}
export interface SystemMessagePresentationPolicy {
  readonly typedConversation: boolean;
  readonly forceConversationPrefixes: readonly string[];
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
  ): void {
    // Noise gate, keep first-run plumbing out of the Recent feed / transcript
    // while the information stays reachable via other live surfaces (activity
    // log, /health, /model). Dropped noise is drop-from-the-feed, not delete.
    const verdict = classifyNoise(message, this.noiseDeps);
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
      if (this.presentation.typedConversation) this.conversation.addTypedSystemMessage(message, kind, runtimeEvent);
      else this.conversation.addSystemMessage(message, runtimeEvent);
    }
  }
  /**
   * Buffer a provider "from last session" replay line and schedule a microtask
   * flush. The SDK emits the whole persisted-provider burst synchronously, so a
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
  routeSystemMessage(message: string, priority: SystemMessagePriority, runtimeEvent?: RuntimeEventProvenance | undefined): void {
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message), runtimeEvent);
  }
  /**
   * Automatically classify the message priority by content and route.
   * Drop-in replacement for conversation.addSystemMessage().
   */
  async routeAuto(message: string): Promise<void> {
    const priority: SystemMessagePriority = await classifySystemMessagePriority(message);
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message));
  }
  /** High-priority shortcut, conversation + activity feed. */
  high(message: string): void {
    this.routeSystemMessage(message, 'high');
  }
  /** Direct response to a user action, always visible on the main screen once. */
  userAction(message: string): void {
    this.conversation.addSystemMessage(message);
    this.feed?.push(message, 'high');
  }
  /** A local receipt bypasses ambient noise and delivery preferences. */
  userReceipt(message: string): void {
    this.conversation.addTypedSystemMessage(message, classifySystemMessageKind(message));
  }
  /** Low-priority shortcut, activity feed only. */
  low(message: string, runtimeEvent?: RuntimeEventProvenance | undefined): void {
    this.routeSystemMessage(message, 'low', runtimeEvent);
  }
  contract(message: string, priority: SystemMessagePriority = 'high', runtimeEvent?: RuntimeEventProvenance | undefined): void {
    this.routeTypedSystemMessage(message, priority, 'contract', runtimeEvent);
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
