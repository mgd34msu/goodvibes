/**
 * agent-view-render.ts, one agent opened full screen.
 *
 * The agent becomes the session: its own transcript is the spine (drawn by
 * the same lane-graph path as main, conversation-rendering.ts), the agents
 * it spawned branch off it as lanes, and steers you sent that it has not
 * picked up yet sit at the bottom marked as queued. Its lanes are drawn with
 * the color base shifted (lane-graph/paint.ts withLaneColorBase) so its spine
 * keeps the color its lane has in main.
 *
 *   row 0     ◆ engineer · the task · started by main 2m 14s ago
 *   row 1     (blank)
 *   rows      the agent's transcript
 *
 * A contract owner supervises a typed work tree; its planner and unit agents
 * branch off the spine with their own transcripts (buildContractOwnerModel).
 *
 * The thin bar down column 0, the blank rows above and below the body, and
 * the scroll window are the caller's (shell/session-views.ts); this returns
 * every line.
 */
import type { MessageLineCache } from './conversation-line-cache.js';
import type { BlockMeta } from './work-tree-types.js';
import { createEmptyLine, type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import type { createConversationRenderer } from './conversation-rendering.js';
import type { ConversationRenderContext } from './conversation-render-context.js';
import { buildContractOwnerModel, type WorkTreePresentation } from './work-tree-model.js';
import { contractIsActive, contractStatusSummary } from './work-tree-contract.js';
import type { AgentLaneInfo, WorkTreeSources } from './work-tree-sources.js';
import { laneColor, withLaneColorBase } from './renderer/lane-graph-paint.js';
import type { TreeGlyphSetName } from './renderer/lane-graph-glyphs.js';
import { renderUserMessage } from './renderer/user-message.js';
import { activeTokens } from './renderer/theme.js';
import { formatElapsed } from './format.js';
import { getDisplayWidth, truncateDisplay } from '@goodvibes-jev/engine/sdk/platform/utils';
export interface AgentViewInput {
    readonly lineCache?: Pick<MessageLineCache<ConversationRenderContext>, 'renderInto'> | undefined;
    readonly contentCache?: import('./bead-content-cache.js').BeadContentCache | undefined;
    readonly blocks?: BlockMeta[] | undefined;
    readonly width: number;
    readonly agent: AgentLaneInfo;
    /** The agent's transcript (a contract owner's work lives in its contract). */
    readonly messages: readonly ConversationMessageSnapshot[];
    /** The agent's lane color index in main. */
    readonly colorIndex: number;
    /** Who started it: "main" or the parent agent's name. */
    readonly parentName: string;
    /** Main's work-tree sources (timings, spawned agents, waiting calls). */
    readonly sources: WorkTreeSources;
    /** Fold state for this view's beads; kept by the caller across frames. */
    readonly collapse: Map<string, boolean>;
    readonly glyphSet: TreeGlyphSetName;
    readonly frame: number;
    readonly now: number;
    /** Steers sent from this view that the agent has not picked up yet, oldest first. */
    readonly queuedSteers: readonly string[];
}
const TEXT_X = 3;
function put(line: Line, x: number, endX: number, text: string, style: {
    fg: string;
    bold?: boolean | undefined;
}): number {
    let cx = x;
    for (const ch of text) {
        const w = getDisplayWidth(ch);
        if (w <= 0)
            continue;
        if (cx + w > endX || cx >= line.length)
            break;
        line[cx] = { char: ch, fg: style.fg, bg: '', bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
        if (w === 2 && cx + 1 < line.length)
            line[cx + 1] = { ...line[cx]!, char: '' };
        cx += w;
    }
    return cx;
}
function stateText(agent: AgentLaneInfo, parentName: string, now: number): {
    text: string;
    tone: 'faint' | 'good' | 'bad' | 'warn';
} {
    if (agent.contract) {
        const contract = agent.contract;
        return { text: contractStatusSummary(contract), tone: contract.status === 'failed' ? 'bad' : contract.status === 'awaiting-owner' || contract.commit?.status === 'failed' ? 'warn' : contract.status === 'passed' ? 'good' : 'faint' };
    }
    const started = agent.startedAt !== undefined ? `started by ${parentName} ${formatElapsed(Math.max(0, now - agent.startedAt))} ago` : `started by ${parentName}`;
    switch (agent.status) {
        case 'running': return { text: started, tone: 'faint' };
        case 'pending': return { text: `waiting to start · ${started}`, tone: 'faint' };
        case 'completed': {
            const took = agent.startedAt !== undefined && agent.completedAt !== undefined ? ` in ${formatElapsed(agent.completedAt - agent.startedAt)}` : '';
            return { text: `finished${took} · ${agent.toolCallCount} tool${agent.toolCallCount === 1 ? '' : 's'}`, tone: 'good' };
        }
        case 'failed': return { text: `failed${agent.error ? `: ${agent.error.split('\n')[0]}` : ''}`, tone: 'bad' };
        case 'cancelled': return { text: 'stopped', tone: 'warn' };
    }
}
/** The ◆ head row. */
function headRow(input: AgentViewInput): Line {
    const t = activeTokens();
    const line = createEmptyLine(input.width);
    for (const cell of line)
        cell.bg = '';
    const end = input.width - 3;
    const color = laneColor(input.colorIndex);
    let x = put(line, TEXT_X, end, '◆', { fg: color, bold: true });
    // A chain owner is named for what it is, as its lane in main is.
    x = put(line, x + 1, end, input.agent.contract ? 'Contract' : input.agent.hostedLabel ?? input.agent.name, { fg: color, bold: true });
    const state = stateText(input.agent, input.parentName, input.now);
    const stateFg = state.tone === 'good' ? t.success : state.tone === 'bad' ? t.error : state.tone === 'warn' ? t.warning : t.textFaint;
    const task = input.agent.task.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
    // The state is kept whole; the task yields its room first.
    const stateW = getDisplayWidth(state.text) + 3;
    const taskRoom = end - x - 3 - stateW;
    if (task && taskRoom >= 8) {
        x = put(line, x + 1, end, '·', { fg: t.textFaint });
        x = put(line, x + 1, end, truncateDisplay(task, taskRoom), { fg: t.textMuted });
    }
    x = put(line, x + 1, end, '·', { fg: t.textFaint });
    put(line, x + 1, end, truncateDisplay(state.text, Math.max(0, end - x - 1)), { fg: stateFg });
    return line;
}
/** Every line of the agent view, top to bottom. */
export function createAgentViewRenderer(renderer: Pick<ReturnType<typeof createConversationRenderer>, 'drawConversationTurn' | 'appendConversationMessages'>, presentation?: WorkTreePresentation | undefined) {
    return function renderAgentView(input: AgentViewInput): Line[] {
        const t = activeTokens();
        const lines: Line[] = [headRow(input), createEmptyLine(input.width)];
        const running = input.agent.contract ? contractIsActive(input.agent.contract) : input.agent.status === 'running' || input.agent.status === 'pending';
        const context: ConversationRenderContext = {
            history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { for (const line of ls)
                    lines.push(line); }, getLineCount: () => lines.length },
            blockRegistry: input.blocks ?? [],
            collapseState: input.collapse,
            errorLineRegistry: [],
            messageKindRegistry: new Map(),
            configManager: null,
            splashOptions: {},
            // The agent's own turns are live while the agent runs, not while main does.
            workTreeSources: { ...input.sources, turnActive: () => running, turnTiming: undefined },
            treeGlyphSet: input.glyphSet,
            focusId: null,
            frame: input.frame,
        };
        if (input.agent.contract) {
            input.contentCache?.begin();
            const model = buildContractOwnerModel({ info: input.agent, sources: context.workTreeSources ?? {}, collapse: input.collapse, beadContentCache: input.contentCache, presentation });
            input.contentCache?.end();
            withLaneColorBase(input.colorIndex, () => {
                const drawn = renderer.drawConversationTurn(context, model, input.width);
                const base = lines.length;
                for (const line of drawn.lines)
                    lines.push(line);
                for (const block of drawn.blocks)
                    context.blockRegistry.push({ ...block, startLine: block.startLine + base });
            });
        }
        else {
            withLaneColorBase(input.colorIndex, () => {
                if (input.lineCache)
                    input.lineCache.renderInto(context, [...input.messages], input.width, [], 0, -1);
                else
                    renderer.appendConversationMessages(context, [...input.messages], input.width, []);
            });
        }
        if (!input.agent.contract && input.messages.length === 0) {
            const note = createEmptyLine(input.width);
            for (const cell of note)
                cell.bg = '';
            put(note, TEXT_X + 2, input.width - 3, running ? 'No transcript yet: the agent has not taken a turn.' : 'This agent left no transcript.', { fg: t.textFaint });
            lines.push(note);
        }
        for (const steer of input.queuedSteers) {
            lines.push(createEmptyLine(input.width));
            lines.push(...renderUserMessage(steer, input.width, { bg: t.backgroundPanel, text: t.text, bar: t.secondary }));
            const note = createEmptyLine(input.width);
            for (const cell of note)
                cell.bg = '';
            put(note, TEXT_X + 2, input.width - 3, '⧗ queued · it arrives at the agent\'s next turn', { fg: t.textFaint });
            lines.push(note);
        }
        return lines;
    };
}
