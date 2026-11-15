import { createUiFactory, type ThinkingStallInfo } from '@goodvibes-jev/engine/terminal-shell/ui-factory';
import { VERSION } from '../version.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { renderHeaderLine } from './header-line.ts';
export type { ThinkingStallInfo } from '@goodvibes-jev/engine/terminal-shell/ui-factory';
export class UIFactory extends createUiFactory({ secondaryQueue: true, previewEndInset: 2 }) {
public static createHeader(width: number, model: string, title?: string, version: string = VERSION): Line[] {
    return renderHeaderLine(width, model, title, version);
  }
public static computeRenderStallInfo(metrics: {
  toolActive: boolean;
  lastDeltaAtMs: number | undefined;
  nowMs: number;
  /** A provider reconnect in progress (STREAM_RETRY); shown as "retrying n/m" instead of a generic stall. */
  reconnectAttempt?: number | undefined;
  reconnectMaxAttempts?: number | undefined;
}): ThinkingStallInfo | undefined { return this.computeFrameStall(metrics); }
}
