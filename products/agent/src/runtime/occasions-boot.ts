/**
 * occasions-boot.ts, the agent's occasion-nudge wiring in one call.
 *
 * ## How a reminder reaches this conversation
 *
 * By the pull: the surface asks `occasions.pending` what is outstanding and
 * raises it. It runs
 *
 * - at the end of every turn;
 * - when the host announces that a reminder is waiting (the sweep publishes
 *   `DELIVERY_WAITING` when it raises something and `occasions.nudgeChannel`
 *   names `agent`), if no turn is running; a running turn's own end pulls it;
 * - while the shell sits idle, once per occasions sweep interval
 *   (`occasions.sweepIntervalMinutes`, read live), which covers a host that
 *   cannot be reached for announcements and reopens the announcement stream.
 *
 * The item stays open on the host until it is answered, so the pull also covers
 * a reminder raised while this process was not running. Cost: one small read per
 * announcement and one per sweep interval while idle and enabled; nothing while a
 * turn runs.
 */

import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { createOccasionsGatewayInvoke } from '@goodvibes-jev/engine/terminal-shell/agent-turn/occasions-gateway';
import { connectedHostFamilyRemote } from '@goodvibes-jev/engine/terminal-shell/agent-turn/family-remote';
import {
  createOccasionsNudgeSurface,
  type OccasionsNudgeSurface,
} from './occasions-nudge-surface.ts';

/** Minutes between idle pulls when the setting says nothing (the sweep's default). */
const DEFAULT_IDLE_PULL_MINUTES = 60;

/** An open announcement subscription. */
export interface OccasionAnnouncementSubscription {
  close(): void;
}

export interface OccasionsBootDeps {
  /** This process's own verb catalog, when it carries the occasions handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** The live transcript a pulled reminder lands in. */
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  /** Where the idle timer's stop and the announcement stream's close are filed, for shutdown. */
  readonly disposals: { push(undo: () => void): void };
  /**
   * True while no turn is running, so a pulled line cannot land inside a
   * streaming reply. Without it there is no idle or announced pull, only the
   * turn-end one.
   */
  readonly isIdle?: (() => boolean) | undefined;
  /**
   * Opens the host's "a reminder is waiting" stream. Resolves to null when it
   * cannot be opened; `onEnded` fires once when an opened stream ends for good.
   */
  readonly watchAnnouncements?: ((handlers: {
    readonly onWaiting: () => void;
    readonly onEnded: () => void;
  }) => Promise<OccasionAnnouncementSubscription | null>) | undefined;
  /** Injectable timer for tests. */
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
}

/**
 * Build the pull surface and start its announced and idle pulls.
 *
 * Returns the pull surface because bootstrap also fires it on the turn's
 * completion, which is a decision about the transcript rather than about
 * occasions (see occasions-nudge-surface.ts on why the end of a turn and not
 * the start).
 */
export function installOccasionsNudging(deps: OccasionsBootDeps): OccasionsNudgeSurface {
  const surface = createOccasionsNudgeSurface({
    invoke: createOccasionsGatewayInvoke({
      gatewayMethods: deps.gatewayMethods,
      // Reads for the owner's own screen: the Agent's ordinary credential.
      remote: connectedHostFamilyRemote({ configManager: deps.configManager, homeDirectory: deps.homeDirectory, actor: 'owner' }),
    }),
    conversation: deps.conversation,
    requestRender: deps.requestRender,
    // The feature's own switch, read live so it is a real toggle. Not a rule:
    // every decision about whether an occasion may be raised stays in the daemon
    // and arrives only as the contents of `occasions.pending`.
    isEnabled: () => deps.configManager.get('occasions.enabled'),
  });

  const isIdle = deps.isIdle;
  if (isIdle === undefined) return surface;
  let stopped = false;

  // The announced pull. Skipped (not queued) while a turn runs: that turn's
  // completion pulls the same still-open items.
  let subscription: OccasionAnnouncementSubscription | null = null;
  let opening = false;
  const openAnnouncements = (): void => {
    const watch = deps.watchAnnouncements;
    if (watch === undefined || stopped || subscription !== null || opening) return;
    opening = true;
    void watch({
      onWaiting: () => { if (!stopped && isIdle()) void surface.raiseNow(); },
      onEnded: () => { subscription = null; },
    }).then((opened) => {
      opening = false;
      if (stopped) opened?.close();
      else subscription = opened;
    }, () => { opening = false; });
  };
  openAnnouncements();

  // The idle pull: re-armed after each pass so a changed interval takes effect
  // at the next one. Skipped (not queued) while a turn runs; the turn's own
  // completion pulls. Each pass also reopens a stream that ended.
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = (): number => {
    const minutes = Number(deps.configManager.get('occasions.sweepIntervalMinutes'));
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_PULL_MINUTES) * 60_000;
  };
  const arm = (): void => {
    if (stopped) return;
    timer = setTimer(() => {
      openAnnouncements();
      if (isIdle()) void surface.raiseNow().finally(arm);
      else arm();
    }, intervalMs());
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  deps.disposals.push(() => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    subscription?.close();
    subscription = null;
  });
  return surface;
}
