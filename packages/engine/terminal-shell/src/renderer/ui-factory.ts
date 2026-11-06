import { stringToLine } from './string-to-line.js';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { truncateDisplay } from '@goodvibes-jev/engine/sdk/platform/utils';
import { renderConversationFragment } from './conversation-surface.js';
import { activeTheme, activeTokens, activeUiTones } from './theme.js';
import { renderQueuedMessageList, renderMemoryProvenanceChip, type MemoryProvenanceEntry } from './composer-fragments.js';
import { renderUserMessage } from './user-message.js';
import { waitingPhrase, type WaitingState } from '@goodvibes-jev/engine/sdk/platform/presentation';
const THINKING_STALL_FREEZE_MS = 2500;
export interface ThinkingStallInfo {
    /** Ms since the last STREAM_DELTA (or STREAM_START if none yet this turn). */
    readonly msSinceLastDelta: number;
    readonly reconnect?: {
        readonly attempt: number;
        readonly maxAttempts: number;
    } | undefined;
}
export function createUiFactory(presentation: {
    readonly secondaryQueue: boolean;
    readonly previewEndInset: number;
}) {
    return class TerminalUiFactory {
        public static createMessageBar(width: number, text: string, bgColor: string = activeTokens().backgroundPanel, textColor: string = activeTokens().text, barColor: string = activeTokens().secondary, strikethrough = false): Line[] {
            return renderUserMessage(text, width, { bar: barColor, bg: bgColor, text: textColor, strikethrough });
        }
        public static createQueuedMessageFragment(width: number, text: string): Line[] {
            const t = activeUiTones();
            return renderConversationFragment(text, width, {
                prefix: ' (...) ',
                prefixFg: presentation.secondaryQueue ? activeTokens().secondary : t.state.reasoning,
                text: presentation.secondaryQueue ? activeTokens().textFaint : t.fg.dim,
                bodyBg: activeTheme().collapsedBodyBg,
            });
        }
        public static createQueuedMessageList(width: number, items: readonly {
            readonly id: string;
            readonly text: string;
        }[]): Line[] {
            return renderQueuedMessageList(width, items);
        }
        public static createMemoryProvenanceChip(width: number, count: number, entries: readonly MemoryProvenanceEntry[], expanded: boolean): Line[] {
            return renderMemoryProvenanceChip(width, count, entries, expanded);
        }
        public static computeStallInfo(lastDeltaAtMs: number | undefined, reconnectAttempt: number | undefined, reconnectMaxAttempts: number | undefined, nowMs: number): ThinkingStallInfo | undefined {
            if (lastDeltaAtMs === undefined)
                return undefined;
            const reconnect = reconnectAttempt !== undefined && reconnectMaxAttempts !== undefined
                ? { attempt: reconnectAttempt, maxAttempts: reconnectMaxAttempts }
                : undefined;
            return { msSinceLastDelta: nowMs - lastDeltaAtMs, reconnect };
        }
        public static busyPhrase(frame: number, outputTokens?: number | undefined, stallInfo?: ThinkingStallInfo | undefined, approvalPending?: boolean | undefined): string {
            const isStalled = stallInfo !== undefined && stallInfo.msSinceLastDelta >= THINKING_STALL_FREEZE_MS;
            let state: WaitingState;
            if (approvalPending)
                state = 'approval';
            else if (stallInfo?.reconnect)
                state = 'reconnecting';
            else if (isStalled && (outputTokens ?? 0) === 0)
                state = 'pre-first-token';
            else if (isStalled)
                state = 'stalled';
            else
                state = 'thinking';
            return waitingPhrase(state, {
                ...(stallInfo?.reconnect ? { reconnectAttempt: stallInfo.reconnect.attempt, reconnectMaxAttempts: stallInfo.reconnect.maxAttempts } : {}),
                ...(stallInfo ? { msSinceLastDelta: stallInfo.msSinceLastDelta } : {}),
                frame,
            });
        }
        public static createToolPreviewRow(width: number, preview: string): Line {
            return this.stringToLine(truncateDisplay(`   tool: ${preview}`, Math.max(0, width - presentation.previewEndInset)), width, { fg: activeTokens().textFaint });
        }
        public static stringToLine = stringToLine;
        public static computeFrameStall(metrics: {
            readonly toolActive: boolean;
            readonly lastDeltaAtMs: number | undefined;
            readonly nowMs: number;
            readonly reconnectAttempt?: number | undefined;
            readonly reconnectMaxAttempts?: number | undefined;
        }): ThinkingStallInfo | undefined {
            return metrics.toolActive ? undefined : this.computeStallInfo(metrics.lastDeltaAtMs, metrics.reconnectAttempt, metrics.reconnectMaxAttempts, metrics.nowMs);
        }
    };
}
