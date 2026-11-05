import { renderStatusLine as paint, type StatusLineOptions } from '@goodvibes-jev/engine/terminal-shell/status-line';
import { tagFooterRegion } from './footer-targets.ts';
export * from '@goodvibes-jev/engine/terminal-shell/status-line';
export const renderStatusLine = (options: StatusLineOptions) => paint({ ...options, tagRegion: tagFooterRegion });
