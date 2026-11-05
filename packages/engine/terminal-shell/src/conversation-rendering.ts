import { stringToLine } from './renderer/string-to-line.js';
import { renderUserMessage } from './renderer/user-message.js';
import { peekSystemMessagePresentation } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { activeTheme, activeTokens } from './renderer/theme.js';
import type { ToolCall } from '@goodvibes-jev/engine/sdk/platform/types';
import { renderSystemMessage } from './renderer/system-message.js';
import { createEmptyLine, type Line, type Cell } from '@goodvibes-jev/engine/sdk/platform/types';
import { SPLASH_GRADIENT, type SplashOptions } from './splash-lines.js';
import { interpolateColor, getDisplayWidth, wrapText } from '@goodvibes-jev/engine/sdk/platform/utils';
import { LAYOUT } from './renderer/layout.js';
import type { ConversationRenderContext } from './conversation-render-context.js';
import { renderCompactionContinuationMessage } from './conversation-compaction-render.js';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import { extractUserDisplayText, COMPACTION_HANDOFF_HEADER } from '@goodvibes-jev/engine/sdk/platform/core';
import { laneGlyphs } from './renderer/lane-graph-glyphs.js';
import { beadArgument, beadName, cellText, formatBeadTime } from './renderer/bead.js';
import { paintBeadRow } from './renderer/lane-graph-paint.js';
import { buildTurnModel, orphanResultBead, transcriptUnits, type TranscriptUnit, type TurnModel, type WorkTreePresentation as ModelPresentation } from './work-tree-model.js';
import { renderSingleBead, renderTurn, type TurnRender, type WorkTreePresentation as RowPresentation } from './work-tree-render.js';
// SystemMessageKind imported from runtime directly to avoid cycle:
//   conversation-rendering.ts → system-message-router.ts → conversation.ts → conversation-rendering.ts
import type { SystemMessageKind } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
// Transcript tokens are read live per render (const T = activeTheme() at the top
// of each render function that styles content) so a dark→light repaint
// re-resolves with no module reload. See theme.ts's active-mode runtime note.
/**
 * Navigable system message kinds for error-navigation (nextErrorLine/prevErrorLine).
 *
 * Kind → navigable mapping:
 *   - 'system'      YES, generic/catch-all messages (provider failures, session
 *                         events, user-visible errors). Default for un-prefixed messages.
 *   - 'wrfc'        YES, WRFC chain events are important and worth navigating to.
 *   - 'operational' NO , tool/scan/plugin/MCP status noise; not useful to jump to.
 *
 * When a message has no recorded kind (added via bare addSystemMessage), it
 * defaults to 'system' and is therefore navigable.
 */
const NAVIGABLE_KINDS: ReadonlySet<SystemMessageKind> = new Set(['system', 'contract']);
type Message = ConversationMessageSnapshot;
// The render context and its pure derivations live in a type-only leaf module
// (conversation-render-context.ts) so per-row render modules can depend on the
// SHAPE of a render without depending on this drawing module. Re-exported here
// because this file remains the transcript renderer's entry point.
export { collectCompletedToolCallIds, collectToolCallOutcomes, type ConversationRenderContext, type ToolCallOutcome, } from './conversation-render-context.js';
export interface ConversationPresentation {
    readonly getSplashLines: (width: number, options: SplashOptions) => string[];
    readonly systemNavigation: 'kind' | 'severity';
    readonly rows: RowPresentation;
    readonly model?: ModelPresentation | undefined;
    readonly compactionPreview: string;
    readonly compactionSpacing: 'leading' | 'trailing';
}
export function isNavigableSystemContent(content: string): boolean {
    return peekSystemMessagePresentation(content)?.severity === 'error';
}
export function createConversationRenderer(presentation: ConversationPresentation) {
    function messageBar(width: number, text: string, bg = activeTokens().backgroundPanel, fg = activeTokens().text, bar = activeTokens().secondary, strikethrough = false): Line[] {
        return renderUserMessage(text, width, { bg, text: fg, bar, strikethrough });
    }
    function navigable(context: ConversationRenderContext, index: number, content: string): boolean {
        return presentation.systemNavigation === 'kind' ? isNavigableSystemMessage(context, index) : isNavigableSystemContent(content);
    }
    /** Whether a system message at `msgIdx` is navigable for error navigation. */
    function isNavigableSystemMessage(context: Pick<ConversationRenderContext, 'messageKindRegistry'>, msgIdx: number): boolean {
        return NAVIGABLE_KINDS.has(context.messageKindRegistry?.get(msgIdx) ?? 'system');
    }
    function renderConversationUserMessage(context: ConversationRenderContext, message: Extract<Message, {
        role: 'user';
    }>, width: number, msgIdx?: number | undefined): void {
        const T = activeTheme();
        const displayText = extractUserDisplayText(message.content);
        if (message.cancelled) {
            context.history.addLines(messageBar(width, displayText, T.errorBarBg, activeTokens().textMuted, activeTokens().error, true));
            return;
        }
        // Compaction-continuation handoff: a user-ROLE message the compactor
        // authored, not something the user typed. Rendered in full it repeats the
        // entire re-injected instruction block after every automatic compaction,
        // a multi-kilobyte wall in the transcript. Fold it like a tool result; the
        // full payload stays reachable through the normal expand toggle.
        if (msgIdx !== undefined && displayText.startsWith(COMPACTION_HANDOFF_HEADER)) {
            renderCompactionContinuationMessage(context, displayText, width, msgIdx, presentation.compactionPreview, presentation.compactionSpacing);
            return;
        }
        context.history.addLines(messageBar(width, displayText));
    }
    function renderConversationSystemMessage(context: ConversationRenderContext, message: Extract<Message, {
        role: 'system';
    }>, width: number, msgIdx = -1): void {
        const sysStartLine = context.history.getLineCount();
        const sysLines = renderSystemMessage(message.content, width, message.presentation?.severity, presentation.rows.systemAccent);
        context.history.addLines(sysLines);
        // Resolve navigability from the stored kind, defaulting to 'system'
        // (navigable) for messages added without an explicit kind tag.
        if (navigable(context, msgIdx, message.content)) {
            context.errorLineRegistry.push(sysStartLine);
        }
    }
    /** Build one assistant turn's work-tree model from the render context. */
    function buildConversationTurnModel(context: ConversationRenderContext, messages: readonly Message[], offset: number, unit: Extract<TranscriptUnit, {
        kind: 'turn';
    }>, streamingIndex = -1): TurnModel {
        const config = context.configManager;
        return buildTurnModel({
            messages,
            presentation: presentation.model,
            offset,
            unit,
            sources: context.workTreeSources ?? {},
            beadContentCache: context.beadContentCache,
            collapse: context.collapseState,
            streamingIndex,
            showThinking: config?.get('display.showThinking') ?? false,
            showReasoningSummary: config?.get('display.showReasoningSummary') ?? false,
        });
    }
    /**
     * Draw a turn model (lines, blocks and error lines relative to the turn), then
     * the notices that arrived during it (never in the main transcript, whose
     * notices are toasts and notification-history entries: systemNotices). A notice is not a step of the turn, so it
     * is drawn after the turn and outside its lanes, exactly as a notice between
     * turns is (the concept's turns hold only the turn's own text, beads, lanes and
     * answer; agent and WRFC state is the lanes' own spawn and merge rows).
     */
    function drawConversationTurn(context: ConversationRenderContext, model: TurnModel, width: number): TurnRender {
        const render = drawTurnRows(context, model, width);
        if (model.notices.length === 0 || context.systemNotices === 'elsewhere')
            return render;
        const lines = [...render.lines];
        const errorLines = [...render.errorLines];
        const messageLines = new Map(render.messageLines);
        for (const notice of model.notices) {
            lines.push(createEmptyLine(width));
            messageLines.set(notice.messageIndex, lines.length);
            if (navigable(context, notice.messageIndex, notice.content))
                errorLines.push(lines.length);
            lines.push(...renderSystemMessage(notice.content, width, undefined, presentation.rows.systemAccent));
        }
        return { ...render, lines, errorLines, messageLines, trailingSeparator: true };
    }
    function drawTurnRows(context: ConversationRenderContext, model: TurnModel, width: number): TurnRender {
        const config = context.configManager;
        return renderTurn(model, {
            width,
            glyphSet: context.treeGlyphSet ?? 'rounded',
            focusId: context.focusId ?? null,
            lineNumberMode: config?.get('display.lineNumbers') ?? 'off',
            collapseThreshold: config?.get('display.collapseThreshold') ?? 30,
            collapseState: context.collapseState,
            isNavigableSystem: (index, content) => navigable(context, index, content),
            frame: context.frame ?? 0,
        }, presentation.rows);
    }
    /**
     * Render one assistant turn through the work tree (work-tree-model.ts builds
     * its rows, work-tree-render.ts draws them) into the context's history.
     */
    function renderConversationTurn(context: ConversationRenderContext, messages: readonly Message[], offset: number, unit: Extract<TranscriptUnit, {
        kind: 'turn';
    }>, width: number, streamingIndex = -1): TurnRender {
        const render = drawConversationTurn(context, buildConversationTurnModel(context, messages, offset, unit, streamingIndex), width);
        const base = context.history.getLineCount();
        const blockBase = context.blockRegistry.length;
        context.history.addLines(render.lines);
        for (const block of render.blocks) {
            context.blockRegistry.push({ ...block, blockIndex: block.blockIndex + blockBase, startLine: block.startLine + base });
        }
        for (const line of render.errorLines)
            context.errorLineRegistry.push(line + base);
        return render;
    }
    /**
     * Render a message slice: user and system messages as themselves, every
     * assistant turn as its work tree. Paragraphs get a trailing separator; task rows do not.
     */
    function appendConversationMessages(context: ConversationRenderContext, messages: Message[], width: number, messageLineRegistry: number[], 
    /**
     * Absolute index of messages[0] in the full (unsliced) conversation snapshot.
     * Required to align slice-relative loop indices with the absolute keys stored
     * in messageKindRegistry, which is keyed at add-time (before any slice).
     * Defaults to 0 when the full snapshot is rendered (no clearDisplay in effect).
     */
    msgIndexOffset = 0): void {
        for (const unit of transcriptUnits(messages, msgIndexOffset)) {
            const before = context.history.getLineCount();
            let trailingSeparator: boolean;
            if (unit.kind === 'turn') {
                const render = renderConversationTurn(context, messages, msgIndexOffset, unit, width);
                trailingSeparator = !presentation.rows.paragraphSpacing || render.trailingSeparator;
                for (const [index, line] of render.messageLines)
                    messageLineRegistry[index] = before + line;
                for (let index = unit.start; index <= unit.end; index++)
                    messageLineRegistry[index] ??= before;
            }
            else {
                messageLineRegistry[unit.index] = before;
                const message = messages[unit.index - msgIndexOffset]!;
                renderConversationMessageUnit(context, message, width, unit.index);
                trailingSeparator = !presentation.rows.paragraphSpacing || message.role !== 'tool';
            }
            if (trailingSeparator && context.history.getLineCount() > before)
                context.history.addLine(createEmptyLine(width));
        }
    }
    /** A standalone message unit (a user message, or a system message outside any turn). */
    function renderConversationMessageUnit(context: ConversationRenderContext, message: Message, width: number, msgIdx: number): void {
        if (message.role === 'user')
            renderConversationUserMessage(context, message, width, msgIdx);
        else if (message.role === 'system') {
            // The main transcript's notices are toasts and history entries, not rows.
            if (context.systemNotices !== 'elsewhere')
                renderConversationSystemMessage(context, message, width, msgIdx);
        }
        else if (message.role === 'tool') {
            // A result whose call is outside the rendered slice (the display was
            // cleared mid-turn): one bead of its own, with its block and body.
            const render = renderSingleBead(orphanResultBead(message, msgIdx, context.collapseState), {
                width,
                glyphSet: context.treeGlyphSet ?? 'rounded',
                focusId: context.focusId ?? null,
                lineNumberMode: 'off',
                collapseThreshold: 30,
                collapseState: context.collapseState,
                isNavigableSystem: () => false,
                frame: context.frame ?? 0,
            });
            const base = context.history.getLineCount();
            const blockBase = context.blockRegistry.length;
            context.history.addLines(render.lines);
            for (const block of render.blocks)
                context.blockRegistry.push({ ...block, blockIndex: blockBase + block.blockIndex, startLine: base + block.startLine });
        }
    }
    function addConversationSplashScreen(context: ConversationRenderContext, width: number): void {
        const splashStrings = presentation.getSplashLines(width, context.splashOptions);
        // The splash gradient is protected: it never follows the theme.
        const { start: cyan, end: purple } = SPLASH_GRADIENT;
        const versionFg = activeTokens().textFaint;
        splashStrings.forEach((str, y) => {
            const line = stringToLine(str, width);
            const isVersion = y === splashStrings.length - 1;
            const startX = Math.floor((width - getDisplayWidth(str)) / 2);
            const endX = startX + getDisplayWidth(str);
            for (let x = 0; x < width; x++) {
                const cell = line[x];
                if (!cell)
                    continue;
                if (cell.char === ' ' && (x < startX || x >= endX))
                    continue;
                if (isVersion) {
                    cell.fg = versionFg;
                }
                else {
                    const factor = (x - startX) / (endX - startX || 1);
                    cell.fg = interpolateColor(cyan, purple, Math.max(0, Math.min(1, factor)));
                    cell.bold = true;
                }
            }
            context.history.addLine(line);
        });
        // No trailing blank rows: the shell centers the splash in whatever height
        // the conversation area has (conversation-layout.ts centerViewportContent).
    }
    function conversationTextToLines(text: string, width: number, style: Partial<Cell> = {}): Line[] {
        const contentWidth = LAYOUT.contentWidth(width);
        const wrapped = wrapText(text, contentWidth);
        return wrapped.map((line, index) => {
            const prefix = index === 0 ? '>' + ' '.repeat(LAYOUT.LEFT_MARGIN - 1) : ' '.repeat(LAYOUT.LEFT_MARGIN);
            return stringToLine(prefix + line, width, style);
        });
    }
    function logConversationText(context: Pick<ConversationRenderContext, 'history'>, width: number, text: string, style: Partial<Cell> = {}, indent = ' '.repeat(LAYOUT.LEFT_MARGIN)): void {
        const lines = text.split('\n').map((line) => stringToLine(indent + line, width, style));
        context.history.addLines(lines);
    }
    /**
     * logConversationToolResult - Append a display-only tool result (a slash
     * command's subprocess result, e.g. /test) as one bead row, the same row a
     * model's own call draws in the work tree. Never touches message history.
     */
    function logConversationToolResult(context: Pick<ConversationRenderContext, 'history' | 'treeGlyphSet'>, width: number, toolCall: ToolCall, status: 'done' | 'error', resultSummary: string, durationMs: number, errorMsg?: string | undefined): void {
        renderStandaloneBead(context, width, toolCall, status, errorMsg ? `${resultSummary ? `${resultSummary} · ` : ''}${errorMsg}` : resultSummary, durationMs);
    }
    function renderStandaloneBead(context: Pick<ConversationRenderContext, 'history' | 'treeGlyphSet'>, width: number, toolCall: ToolCall, status: 'done' | 'error', summary: string, durationMs: number | undefined): void {
        const glyphs = laneGlyphs(context.treeGlyphSet ?? 'rounded');
        context.history.addLine(paintBeadRow([{ role: 'bead', color: 0 }], {
            status: status === 'error' ? 'err' : 'ok',
            name: beadName(toolCall),
            arg: beadArgument(toolCall),
            summary: summary ? { text: cellText(summary), tone: status === 'error' ? 'bad' : 'faint' } : null,
            time: durationMs !== undefined ? formatBeadTime(durationMs) : undefined,
            laneColor: activeTokens().brand,
            hasBody: false,
            open: false,
        }, { width, gutterWidth: 6, glyphs, frame: 0 }));
    }
    return { isNavigableSystemMessage, renderConversationUserMessage, renderConversationSystemMessage, buildConversationTurnModel, drawConversationTurn, renderConversationTurn, appendConversationMessages, renderConversationMessageUnit, addConversationSplashScreen, conversationTextToLines, logConversationText, logConversationToolResult };
}
