/**
 * conversation-render-context.ts, the inputs a transcript row render reads,
 * and the small pure derivations over them.
 *
 * Kept apart from conversation-rendering.ts (which draws) so that both the
 * drawing module and the per-row modules that hang off it can depend on the
 * SHAPE of a render without depending on each other. Every import here is
 * type-only, which is what makes this a leaf of the import graph.
 */
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { BlockMeta } from './work-tree-types.js';
import type { WorkTreeSources } from './work-tree-sources.js';
import type { TreeGlyphSetName } from './renderer/lane-graph-glyphs.js';
import type { SplashOptions } from './splash-lines.js';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
// SystemMessageKind imported from runtime directly to avoid cycle:
//   conversation-rendering.ts → system-message-router.ts → conversation.ts → conversation-rendering.ts
import type { SystemMessageKind } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
type Message = ConversationMessageSnapshot;
/** Execution outcomes are recorded facts. Legacy content parsing is an explicit compatibility option. */
export type ToolCallOutcome = 'ok' | 'error' | 'cancelled';
function outcomeOfToolContent(content: string): ToolCallOutcome {
    if (/^Error: cancelled by user\b/.test(content))
        return 'cancelled';
    if (/^Error: /.test(content))
        return 'error';
    return 'ok';
}
/**
 * Collect, per tool-call id, how that call settled, for the calls that have a
 * matching tool-result message in the given slice. A call absent from the map
 * has not run yet (e.g. it is still awaiting an approval decision) and renders
 * with the pending glyph. (item 2c.)
 */
export function collectToolCallOutcomes(messages: readonly Message[], legacyContentOutcomes = false): Map<string, ToolCallOutcome> {
    const outcomes = new Map<string, ToolCallOutcome>();
    for (const message of messages) {
        if (message.role === 'tool' && message.callId) {
            if (message.outcome !== undefined)
                outcomes.set(message.callId, message.outcome);
            else if (legacyContentOutcomes)
                outcomes.set(message.callId, outcomeOfToolContent(message.content));
            else
                outcomes.delete(message.callId);
        }
    }
    return outcomes;
}
/**
 * Ids of tool calls that have a matching tool-result message, i.e. the tools
 * that actually ran, regardless of how they settled. Derived from
 * collectToolCallOutcomes so the two can never disagree about what "ran" means.
 */
export function collectCompletedToolCallIds(messages: readonly Message[]): Set<string> {
    return new Set(messages.flatMap(message => message.role === 'tool' && message.callId ? [message.callId] : []));
}
export interface ConversationRenderContext {
    readonly beadContentCache?: import('./bead-content-cache.js').BeadContentCache | undefined;
    readonly history: {
        addLine: (line: Line) => void;
        addLines: (lines: Line[]) => void;
        getLineCount: () => number;
    };
    readonly blockRegistry: BlockMeta[];
    readonly collapseState: Map<string, boolean>;
    readonly errorLineRegistry: number[];
    /** Maps message index → SystemMessageKind for typed system messages. */
    readonly messageKindRegistry?: ReadonlyMap<number, SystemMessageKind> | undefined;
    readonly configManager: ConfigManager | null;
    readonly splashOptions: SplashOptions;
    /**
     * 'elsewhere' for the main transcript: its system notices ([WRFC] …,
     * [Agents] …, compaction receipts) are toasts and notification-history
     * entries (core/notices.ts), so no row is drawn for them. Absent (an agent
     * view drawing a sub-agent's own conversation): drawn after the turn.
     */
    readonly systemNotices?: 'elsewhere' | undefined;
    /**
     * Tool-call ids that have a corresponding tool-result message (i.e. the tool
     * actually ran). An assistant tool call whose id is NOT in this set is still
     * awaiting a decision (e.g. an approval prompt) and renders with a pending
     * glyph instead of the completed ✓. When undefined (single-message callers
     * without sibling context), every tool call renders as done, the prior
     * behaviour. (item 2c.)
     */
    readonly completedToolCallIds?: ReadonlySet<string> | undefined;
    /**
     * How each settled tool call turned out, keyed by call id (see
     * collectToolCallOutcomes). Lets a call row show ✕ for a failure and ⊘ for a
     * cancellation instead of a blanket ✓ the moment any result arrives. When
     * undefined the row falls back to completedToolCallIds' ran/not-ran split.
     */
    readonly toolCallOutcomes?: ReadonlyMap<string, ToolCallOutcome> | undefined;
    /**
     * Live facts the work tree draws that the transcript does not carry: call
     * and turn timings, spawned agents' lanes, the call a permission prompt is
     * holding. Undefined draws the work tree without them (no times, no agent
     * lanes).
     */
    readonly workTreeSources?: WorkTreeSources | undefined;
    /** Glyph set for the work tree (display.treeGlyphs, ascii on a limited terminal). */
    readonly treeGlyphSet?: TreeGlyphSetName | undefined;
    /** Focused work-tree row id while the keyboard is in the work tree. */
    readonly focusId?: (string | null) | undefined;
    /** Spinner frame for running beads. */
    readonly frame?: number | undefined;
}
