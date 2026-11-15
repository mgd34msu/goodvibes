/**
 * occasions-boot.ts, the agent's occasion-nudge wiring in one call.
 *
 * ## How a reminder reaches this conversation
 *
 * By the pull: the surface asks `occasions.pending` what is outstanding and
 * raises it. It runs at the end of every turn, and while the shell sits idle it
 * runs again once per occasions sweep interval (`occasions.sweepIntervalMinutes`,
 * read live), so a reminder the daemon raised while the owner was away from the
 * keyboard shows up without him typing first. Cost: one small read per sweep
 * interval while idle and enabled; nothing while a turn runs.
 *
 * The daemon's sweep cannot land a message here itself: it runs in another
 * process, and a delivery it addresses to `agent` reaches no sender there. The
 * pull is what carries the reminder; the item stays open on the daemon until it
 * is answered, so the pull also covers a reminder raised while this process was
 * not running.
 *
 * The in-process sender stays registered on this process's own router, for the
 * agent's own `agent` channel sends.
 */

import type { ConfigManager } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { createOccasionsGatewayInvoke } from '../agent/occasions-gateway.ts';
import {
  installAgentConversationSender,
  type AgentDeliveryHost,
} from './agent-conversation-sender.ts';
import {
  createOccasionsNudgeSurface,
  type OccasionsNudgeSurface,
} from './occasions-nudge-surface.ts';

/** Minutes between idle pulls when the setting says nothing (the sweep's default). */
const DEFAULT_IDLE_PULL_MINUTES = 60;

export interface OccasionsBootDeps {
  /** Owns the `agent` delivery destination the push half registers on. */
  readonly router: AgentDeliveryHost;
  /** This process's own verb catalog, when it carries the occasions handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  /** The live transcript both halves land in. */
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  /** Where the push registration's undo and the idle timer's stop are filed, for shutdown. */
  readonly disposals: { push(undo: () => void): void };
  /**
   * True while no turn is running, so a pulled line cannot land inside a
   * streaming reply. Without it there is no idle pull, only the turn-end one.
   */
  readonly isIdle?: (() => boolean) | undefined;
  /** Injectable timer for tests. */
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
}

/**
 * Register the in-process sender, build the pull surface and start its idle pull.
 *
 * Returns the pull surface because bootstrap also fires it on the turn's
 * completion, which is a decision about the transcript rather than about
 * occasions (see occasions-nudge-surface.ts on why the end of a turn and not
 * the start).
 */
export function installOccasionsNudging(deps: OccasionsBootDeps): OccasionsNudgeSurface {
  // This process's own `agent` destination, for sends made in this process.
  installAgentConversationSender({
    router: deps.router,
    disposals: deps.disposals,
    // Read per call, not captured: this runs before the session id is final, and
    // a captured reference would pin the conversation the process started with.
    primaryConversation: () => deps.conversation,
    requestRender: deps.requestRender,
  });

  const surface = createOccasionsNudgeSurface({
    invoke: createOccasionsGatewayInvoke({
      gatewayMethods: deps.gatewayMethods,
      configManager: deps.configManager,
      homeDirectory: deps.homeDirectory,
    }),
    conversation: deps.conversation,
    requestRender: deps.requestRender,
    // The feature's own switch, read live so it is a real toggle. Not a rule:
    // every decision about whether an occasion may be raised stays in the daemon
    // and arrives only as the contents of `occasions.pending`.
    isEnabled: () => deps.configManager.get('occasions.enabled'),
  });

  // The idle pull: re-armed after each pass so a changed interval takes effect
  // at the next one. Skipped (not queued) while a turn runs; the turn's own
  // completion pulls.
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const intervalMs = (): number => {
    const minutes = Number(deps.configManager.get('occasions.sweepIntervalMinutes'));
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_PULL_MINUTES) * 60_000;
  };
  const isIdle = deps.isIdle;
  if (isIdle === undefined) return surface;
  const arm = (): void => {
    if (stopped) return;
    timer = setTimer(() => {
      if (isIdle()) void surface.raiseNow().finally(arm);
      else arm();
    }, intervalMs());
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  deps.disposals.push(() => { stopped = true; if (timer !== undefined) clearTimeout(timer); });
  return surface;
}
