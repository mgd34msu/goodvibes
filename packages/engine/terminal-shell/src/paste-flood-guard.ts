/** Sticky command-key burst guard. Ordinary composer typing and modal input stay outside it. */
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
export const PASTE_FLOOD_WINDOW_MS = 120;
export const PASTE_FLOOD_THRESHOLD = 8;

/**
 * Guard state, a single persistent instance lives on the caller's
 * long-lived context (this agent's handler-feed.ts InputFeedContext, mirroring
 * how that object already owns `nextPasteId`/`mouseDownRow`/etc.) and is
 * MUTATED IN PLACE by trackPasteFloodGuard below, never replaced, so
 * callers never need to thread a return value back into their own state.
 */
export interface PasteBurstGuardState {
  timestamps: readonly number[];
  suspended: boolean;
  hintShown: boolean;
}

export interface PasteBurstGuardResult {
  /** False while suspended, the caller must drop this token, not dispatch it. */
  readonly dispatch: boolean;
  /** True exactly once per burst: the call that just tripped suspension. */
  readonly showHintNow: boolean;
}

/** Advance `guard` (mutated in place) by one qualifying token at time `now` (ms). */
export function trackPasteFloodGuard(guard: PasteBurstGuardState, now: number): PasteBurstGuardResult {
  const lastAt = guard.timestamps.at(-1) ?? -Infinity;
  const isQuietGap = now - lastAt > PASTE_FLOOD_WINDOW_MS;
  if (isQuietGap && guard.suspended) {
    // A silence at least as long as the window means whatever burst was
    // happening has ended, un-suspend so a LATER burst gets its own fresh
    // count and its own one-shot hint.
    guard.suspended = false;
    guard.hintShown = false;
  }
  guard.timestamps = isQuietGap ? [now] : [...guard.timestamps.filter((t) => t > now - PASTE_FLOOD_WINDOW_MS), now];
  if (guard.timestamps.length > PASTE_FLOOD_THRESHOLD) {
    guard.suspended = true;
  }
  let showHintNow = false;
  if (guard.suspended && !guard.hintShown) {
    guard.hintShown = true;
    showHintNow = true;
  }
  return { dispatch: !guard.suspended, showHintNow };
}

export interface CommandPasteGuardContext {
  readonly commandMode: boolean;
  readonly burstGuard: PasteBurstGuardState;
  burstSuppressedCount: number;
  readonly commandContext?: { print(text: string): void } | undefined;
  readonly requestRender: () => void;
}
/** Return true only for a suppressed command-mode key, with one notice per burst. */
export function guardCommandPaste(context: CommandPasteGuardContext, token: InputToken, now: number): boolean {
  if (token.type !== 'key' || !context.commandMode) return false;
  const wasSuspended = context.burstGuard.suspended;
  const guard = trackPasteFloodGuard(context.burstGuard, now);
  if (!guard.dispatch) {
    context.burstSuppressedCount++;
    if (guard.showHintNow) {
      context.commandContext?.print('[paste] unbracketed paste flood detected: suppressing extra keystrokes until it settles');
      context.requestRender();
    }
    return true;
  }
  if (wasSuspended) {
    context.commandContext?.print(`[paste] flood cleared: suppressed ${context.burstSuppressedCount} keystroke(s)`);
    context.burstSuppressedCount = 0;
    context.requestRender();
  }
  return false;
}
