/**
 * session-binding.ts, client state names the session it was captured for.
 *
 * A surface that can switch daemons or sessions (the terminal's attach, the
 * web UI's session view) captures input, steers, drafts, kill and detach
 * targets and stream frames while one session is attached and applies them
 * later. Each carries the {@link SessionBinding} current when it was
 * captured; it is applied only while that binding is still current, and is
 * otherwise kept for its own session or refused naming the session it was
 * for and the one now attached. Any change of daemon target or session moves
 * the generation, so re-attaching the same session after a switch is a new
 * binding too (what was captured before the switch was for the earlier
 * attachment).
 *
 * Browser-safe: no `node:` import. One integer compare per check.
 */
import { TargetChangedError, targetRef, type TargetRef } from '../../utils/target-ref.js';

/** Which daemon target (`DaemonTarget.id`) and session a piece of client state belongs to, and which attachment. */
export interface SessionBinding {
  readonly targetId: string;
  readonly sessionId: string;
  readonly generation: number;
}

function bindingRef(binding: SessionBinding | null): TargetRef<'session'> | null {
  if (binding === null) return null;
  return targetRef('session', binding.sessionId,
    { targetId: binding.targetId, generation: binding.generation },
    { daemon: binding.targetId.replace(/#.*$/, ''), attachment: `attachment ${binding.generation}` },
    binding.targetId);
}

/** The one holder of a surface's current attachment. */
export class SessionBindingOwner {
  private generation = 0;
  private held: SessionBinding | null = null;

  /** Attach to `sessionId` on daemon target `targetId`; any change moves the generation. */
  bind(targetId: string, sessionId: string): SessionBinding {
    if (this.held && this.held.targetId === targetId && this.held.sessionId === sessionId) return this.held;
    this.generation += 1;
    this.held = Object.freeze({ targetId, sessionId, generation: this.generation });
    return this.held;
  }

  /** Detach: nothing captured before is current any more. */
  clear(): void {
    if (this.held === null) return;
    this.generation += 1;
    this.held = null;
  }

  current(): SessionBinding | null {
    return this.held;
  }

  /** The same attachment: same daemon target, same session, no switch since. What a stream frame or an open dialog needs. */
  isCurrent(binding: SessionBinding): boolean {
    return this.held !== null && this.held.generation === binding.generation
      && this.held.sessionId === binding.sessionId && this.held.targetId === binding.targetId;
  }

  /**
   * The same session on the same daemon target, attached again or not since:
   * what something kept for its own session (a queued steer, a draft) waits
   * for before it is delivered.
   */
  isSameSession(binding: SessionBinding): boolean {
    return this.held !== null && this.held.sessionId === binding.sessionId && this.held.targetId === binding.targetId;
  }

  /**
   * Throws {@link TargetChangedError} (kind 'session') naming the session
   * `binding` was for and the one now attached. `what` is the thing being
   * applied ("the steer", "the draft"); it opens the next step.
   */
  assertCurrent(binding: SessionBinding, what: string): void {
    if (this.isCurrent(binding)) return;
    const reviewed = bindingRef(binding)!;
    const now = bindingRef(this.held);
    const changes = now === null
      ? [{ field: 'session', was: binding.sessionId, now: null }]
      : [
          ...(now.id !== binding.sessionId ? [{ field: 'session', was: binding.sessionId, now: now.id }] : []),
          ...(this.held!.targetId !== binding.targetId ? [{ field: 'daemon', was: reviewed.shown.daemon!, now: now.shown.daemon! }] : []),
          ...(now.id === binding.sessionId && this.held!.targetId === binding.targetId
            ? [{ field: 'attachment', was: reviewed.shown.attachment!, now: now.shown.attachment! }] : []),
        ];
    throw new TargetChangedError(reviewed, changes,
      `${what} was for session ${binding.sessionId}; attach to it again to apply it there`);
  }
}
