/**
 * conversation-render-context.ts, the inputs a transcript row render reads.
 *
 * Kept apart from conversation-rendering.ts (which draws) so that both the
 * drawing module and the per-row modules that hang off it can depend on the
 * SHAPE of a render without depending on each other. Every import here is
 * type-only, which is what makes this a leaf of the import graph.
 */
import type { Line } from '@goodvibes/engine/platform/platform/types';
import type { BlockMeta } from './work-tree-types.js';
import type { WorkTreeSources } from './work-tree-sources.js';
import type { TreeGlyphSetName } from './renderer/lane-graph-glyphs.js';
import type { SplashOptions } from './splash-lines.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
// SystemMessageKind imported from runtime directly to avoid cycle:
//   conversation-rendering.ts → system-message-router.ts → conversation.ts → conversation-rendering.ts
import type { SystemMessageKind } from '@goodvibes/engine/platform/platform/runtime/shell';
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
     * [Agents] …, compaction receipts) are notification-history
     * entries (core/notices.ts), so no row is drawn for them. Absent (an agent
     * view drawing a sub-agent's own conversation): drawn after the turn.
     */
    readonly systemNotices?: 'elsewhere' | undefined;
    /**
     * Whether the user-role message at an index was put there by the host for
     * the model (delegated results, runtime observations), not typed by the
     * person: it is never drawn as the person's prompt. Absent: every user
     * message is the person's.
     */
    readonly isRuntimeMessage?: ((index: number) => boolean) | undefined;
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
