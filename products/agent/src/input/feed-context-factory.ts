import { buildInitialFeedContext as buildContext, type FeedContextStableKeys, type FeedContextClosureKeys } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
import type { InputFeedContext } from './handler-feed.ts';
import type { FeedContextMutableInit } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
export { syncFeedContextMutableFields } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
export type { FeedContextMutableInit };
/** Product-only ports stay bound here; allocation and scalar synchronization are platform owned. */
export type FeedContextStableRefs = Pick<InputFeedContext, FeedContextStableKeys | "burstGuard" | "agentWorkspace" | "processModal" | "liveTailModal">;
export type FeedContextClosures = Pick<InputFeedContext, FeedContextClosureKeys | "cycleAgentWorkspaceCategory" | "dismissAgentWorkspace">;
export function buildInitialFeedContext(mutable: FeedContextMutableInit, stable: FeedContextStableRefs, closures: FeedContextClosures): InputFeedContext {
  return { ...buildContext(mutable, stable, closures), burstSuppressedCount: 0 };
}
