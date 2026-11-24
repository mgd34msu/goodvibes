import { createUiFactory, type ThinkingStallInfo } from '@goodvibes/engine/terminal-shell/ui-factory';
import { VERSION } from '../version.ts';
import type { Line } from '@goodvibes/engine/platform/platform/types';
import { renderHeaderLine } from './header-line.ts';
import type { GitHeaderInfo } from './git-status.ts';
import type { StreamMetrics } from '../core/stream-metrics.ts';
export type { ThinkingStallInfo } from '@goodvibes/engine/terminal-shell/ui-factory';
export class UIFactory extends createUiFactory({ secondaryQueue: false, previewEndInset: 0 }) {
public static createHeader(width: number, model: string, title?: string, gitInfo?: GitHeaderInfo, version: string = VERSION, modelNote?: string, where?: string): Line[] {
    return renderHeaderLine(width, model, title, gitInfo, version, modelNote, undefined, where);
  }
public static computeRenderStallInfo(metrics: Pick<StreamMetrics, 'runningTools' | 'lastDeltaAtMs' | 'reconnectAttempt' | 'reconnectMaxAttempts'>, nowMs: number): ThinkingStallInfo | undefined {
  return this.computeFrameStall({ toolActive: metrics.runningTools.size > 0, lastDeltaAtMs: metrics.lastDeltaAtMs, reconnectAttempt: metrics.reconnectAttempt, reconnectMaxAttempts: metrics.reconnectMaxAttempts, nowMs });
}
}
