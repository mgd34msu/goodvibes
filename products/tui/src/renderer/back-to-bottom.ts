import { renderBackToBottomPill as paint, type BackToBottomState } from '@goodvibes-jev/engine/terminal-shell/back-to-bottom';
import { tagFooterRegion } from './footer-targets.ts';
export * from '@goodvibes-jev/engine/terminal-shell/back-to-bottom';
export const renderBackToBottomPill = (width: number, state: BackToBottomState) => paint(width, state, tagFooterRegion);
