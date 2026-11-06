import { buildInitialFeedContext as buildContext, type FeedContextStableKeys, type FeedContextClosureKeys } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
import type { InputFeedContext } from './handler-feed.ts';
import type { FeedContextMutableInit } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
export { syncFeedContextMutableFields } from '@goodvibes-jev/engine/terminal-shell/input-feed-context';
export type { FeedContextMutableInit };
/** Product-only ports stay bound here; allocation and scalar synchronization are platform owned. */
export type FeedContextStableRefs = Pick<InputFeedContext, FeedContextStableKeys | "configModal" | "onboardingWizard" | "killRing">;
export type FeedContextClosures = Pick<InputFeedContext, FeedContextClosureKeys | "handleDiffApply" | "saveUndoStateForText" | "breakUndoCoalesce" | "footerTargetAt" | "openFooterTarget" | "onOnboardingAction" | "onStepChange">;
export function buildInitialFeedContext(mutable: FeedContextMutableInit, stable: FeedContextStableRefs, closures: FeedContextClosures): InputFeedContext {
  return buildContext(mutable, stable, closures);
}
