/**
 * lane-graph/bead.ts, what one tool call's bead says: its status mark, its
 * name and key argument, the result summary on its row, and what opening it
 * shows.
 *
 * The bead IS the status mark. There is no separate result row and no
 * separate live row: a running call spins on its own bead, a failed call's
 * bead is the ✕, and the result's one-line summary sits on the same row,
 * right-aligned before the time.
 *
 * The words are the shared tool-call summary (contracts/src/tool-call-summary.ts),
 * which the web UI reads too; this file binds it to the tool registry's display
 * words and keeps what only the terminal draws. paint.ts draws it.
 */
import type { ToolCall } from '@goodvibes/engine/platform/platform/types';
import { beadName as summaryName } from '@goodvibes/engine/contracts';
import { toolActivityOf } from '@goodvibes/engine/platform/platform/tools';

export {
    beadArgument,
    beadBody,
    beadStatus,
    beadSummary,
    cellText,
    formatBeadTime,
    inferResultToolName,
    isBackgroundCall,
    needsAttention,
    toolFamily,
} from '@goodvibes/engine/contracts';
export type {
    BeadBody,
    BeadStatus,
    BeadStatusInput,
    BeadSummary,
    BodyTone,
    CallOutcome,
    ReadBodyFile,
    SummaryTone,
} from '@goodvibes/engine/contracts';

/**
 * The name drawn on the bead row: the running phrase from the tool's own
 * display words in the registry ("Reading files"), chosen by its action when
 * the tool declares words per action; "Using <name>" for a tool that declares none.
 */
export function beadName(call: Pick<ToolCall, 'name'> & { readonly arguments?: Readonly<Record<string, unknown>> | undefined }): string {
    return summaryName({ name: call.name, arguments: call.arguments, activity: toolActivityOf(call.name) });
}

/** Compact dollars: $0.12, $1.40, $12. */
export function formatCost(usd: number): string {
    if (usd >= 10)
        return `$${Math.round(usd)}`;
    return `$${usd.toFixed(2)}`;
}
