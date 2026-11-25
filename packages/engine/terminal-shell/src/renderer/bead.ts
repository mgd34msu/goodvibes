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
import { beadArgument as summaryArgument, beadName as summaryName } from '@goodvibes/engine/contracts';
import { toolActivityOf } from '@goodvibes/engine/platform/platform/tools';
import { movedCapabilityEntries } from '@goodvibes/engine/platform/platform/capabilities';

export {
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

/** Each capability's label by its id, read once (the definitions do not change while the program runs). */
let capabilityLabels: ReadonlyMap<string, string> | undefined;
function capabilityLabel(id: string): string | undefined {
    capabilityLabels ??= new Map(movedCapabilityEntries().map((entry) => [entry.id, entry.label] as const));
    return capabilityLabels.get(id);
}

/**
 * The key argument on the bead row: the shared summary's, except that a capability the model runs is named by its
 * label ("Give a card's security code to a purchase waiting for it"), never by its id ("payments.security-code"). An
 * id with no label here (a daemon method named directly) stays as written.
 */
export function beadArgument(call: Parameters<typeof summaryArgument>[0]): string {
    const id = call.name === 'capability_run' ? call.arguments?.['id'] : undefined;
    const label = typeof id === 'string' ? capabilityLabel(id) : undefined;
    return label ?? summaryArgument(call);
}

