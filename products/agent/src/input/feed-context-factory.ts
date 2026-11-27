import { buildInitialFeedContext as buildContext, type FeedContextStableKeys, type FeedContextClosureKeys } from '@goodvibes/engine/terminal-shell/input-feed-context';
import type { InputFeedContext } from './handler-feed.ts';
import type { FeedContextMutableInit } from '@goodvibes/engine/terminal-shell/input-feed-context';
export type { FeedContextMutableInit };
/** Product-only ports stay bound here; allocation and scalar synchronization are platform owned. */
export type FeedContextStableRefs = Pick<InputFeedContext, FeedContextStableKeys | "burstGuard" | "processModal" | "liveTailModal">;
export type FeedContextClosures = Pick<InputFeedContext, FeedContextClosureKeys | "footerTargetAt" | "openFooterTarget">;
export function buildInitialFeedContext(mutable: FeedContextMutableInit, stable: FeedContextStableRefs, closures: FeedContextClosures): InputFeedContext {
  // Add to the built context itself: spreading it would copy the composer fields' current values and
  // detach them from the handler, so typing would edit a copy the screen never draws.
  return Object.assign(buildContext(mutable, stable, closures), { burstSuppressedCount: 0 });
}
