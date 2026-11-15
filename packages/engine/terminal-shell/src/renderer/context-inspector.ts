import type { ConversationManager } from '@goodvibes-jev/engine/platform/platform/core';
import { estimateTokens } from '@goodvibes-jev/engine/platform/platform/core';
type InspectorConversation = Pick<ConversationManager, 'getMessagesForLLM'>;
import { activeTokens } from './theme.js';
import { beginModal, finishModal, scrollCountText, type KitHint, type SurfaceLayer, } from './surface-kit.js';
import { drawList, listScrollEnd, type KitRow } from './surface-kit-list.js';
import { drawTextBlock, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.js';
// ─── ContextInspectorModal ────────────────────────────────────────────────────
/**
 * ContextInspectorModal, state for the context inspector overlay. The list
 * opens on the newest messages; ↑ scrolls back toward older ones.
 */
export class ContextInspectorModal {
    public active = false;
    /** Rows scrolled back from the newest message (0 = the newest are in view). */
    public scrollBack = 0;
    /** The furthest the list can scroll back, recorded by the renderer. */
    public maxScrollBack = 0;
    open(): void {
        this.active = true;
        this.scrollBack = 0;
    }
    close(): void {
        this.active = false;
        this.scrollBack = 0;
    }
    /** Positive scrolls back toward older messages, negative toward the newest. */
    scrollBy(delta: number): void {
        this.scrollBack = Math.max(0, Math.min(this.maxScrollBack, this.scrollBack + delta));
    }
}
// ─── renderContextInspector ───────────────────────────────────────────────────
/** The static strings this surface can show (checked by package verification). */
export function renderContextInspectorPackageText(): string {
    return [
        'Context inspector',
        'No messages in conversation yet.',
        'Total ~<tokens> tokens in <count> messages · <tokens> of <window> (<percent>)',
        '<tokens> tokens sent with the last request · <tokens> of <window> (<percent>)',
        'system prompt and tools',
        'Context is 80% full or more. Run /compact to free space.',
        '● <count> messages use <percent> of context (each over 10%).',
        'Run /compact to summarise and reduce context size.',
        'scroll',
    ].join('\n');
}
/** Format a number with thousands separators. */
function fmtN(n: number): string {
    return n.toLocaleString();
}
/** Format a percentage as XX.X%. */
function fmtPct(ratio: number): string {
    return `${(ratio * 100).toFixed(1)}%`;
}
interface MsgEntry {
    readonly tokens: number;
    readonly label: string;
}
function messageEntries(conversation: InspectorConversation): {
    entries: MsgEntry[];
    total: number;
} {
    const entries: MsgEntry[] = [];
    let total = 0;
    for (const msg of conversation.getMessagesForLLM()) {
        const role = msg.role;
        let text = '';
        if (typeof msg.content === 'string') {
            text = msg.content;
        }
        else if (Array.isArray(msg.content)) {
            text = (msg.content as Array<{
                type: string;
                text?: string | undefined;
            }>)
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('');
        }
        // Include tool call text for assistant messages
        const toolCalls = (msg as {
            toolCalls?: Array<{
                name: string;
                arguments: unknown;
            }> | undefined;
        }).toolCalls;
        if (role === 'assistant' && toolCalls) {
            for (const tc of toolCalls)
                text += tc.name + JSON.stringify(tc.arguments);
        }
        const tokens = estimateTokens(text);
        total += tokens;
        // A one-line excerpt identifies the message; the inspector is about its
        // token cost, not its content.
        const excerpt = (limit: number): string => `${text.slice(0, limit).replace(/\s+/g, ' ')}${text.length > limit ? '…' : ''}`;
        let label: string;
        if (role === 'user')
            label = `user: ${excerpt(60)}`;
        else if (role === 'assistant')
            label = `assistant: ${excerpt(56)}`;
        else if (role === 'tool')
            label = `tool result ${((msg as {
                callId?: string | undefined;
            }).callId ?? '').slice(0, 12)}`;
        else
            label = role;
        entries.push({ tokens, label });
    }
    return { entries, total };
}
/**
 * Render the context inspector as a SurfaceLayer in screen coordinates.
 *
 * Lists each message with its estimated token count and share of the total
 * (right-aligned), marks large consumers (>10%) with an amber ●, shows the
 * total against the context window, and suggests compaction targets.
 *
 * `providerTokens` is the provider's own count of the last request (system
 * prompt, tool definitions and messages), the number the status-line meter
 * shows. When it is known it is the total and the fill percentage, and the
 * part the messages do not account for is one "system prompt and tools" row,
 * so the two displays agree. Before the first reply the header shows the
 * messages' estimate (marked ~).
 */
export function renderContextInspector(conversation: InspectorConversation, screenWidth: number, screenHeight = 24, contextWindow = 0, modal?: ContextInspectorModal | undefined, providerTokens = 0): SurfaceLayer {
    const t = activeTokens();
    const measured = messageEntries(conversation);
    const counted = providerTokens > 0;
    const remainder = counted ? Math.max(0, providerTokens - measured.total) : 0;
    const entries: MsgEntry[] = remainder > 0 ? [{ tokens: remainder, label: 'system prompt and tools' }, ...measured.entries] : measured.entries;
    const total = counted ? providerTokens : measured.total;
    // Messages added since the last request can exceed its count: shares are of the larger.
    const shareBase = Math.max(total, measured.total);
    const messageCount = measured.entries.length;
    if (messageCount === 0) {
        const lines: TextLine[] = [{ text: 'No messages in conversation yet.', style: { fg: t.textMuted } }];
        const width = modalTextWidth(screenWidth, screenHeight);
        const height = modalHeightFor(screenWidth, screenHeight, {}, textBlockHeight(lines, width));
        const f = beginModal(screenWidth, screenHeight, { title: 'Context inspector', height, center: true });
        drawTextBlock(f.canvas, f.l, f.top, f.r - f.l + 1, lines, f.bottom);
        return finishModal(f);
    }
    const largeThreshold = shareBase * 0.10;
    const large = measured.entries.filter((e) => e.tokens > largeThreshold);
    const capacity = contextWindow > 0 ? ` · ${fmtN(total)} of ${fmtN(contextWindow)} (${fmtPct(total / contextWindow)})` : '';
    const topLines: TextLine[] = counted
        ? [{ text: `${fmtN(total)} tokens sent with the last request${capacity}`, style: { fg: t.text, bold: true } }]
        : [{ text: `Total ~${fmtN(total)} tokens in ${messageCount} message${messageCount === 1 ? '' : 's'}${capacity}`, style: { fg: t.text, bold: true } }];
    if (contextWindow > 0 && total / contextWindow >= 0.80) {
        topLines.push({ text: 'Context is 80% full or more. Run /compact to free space.', style: { fg: t.warning, bold: true } });
    }
    const bottomLines: TextLine[] = [];
    if (large.length > 0) {
        const share = fmtPct(large.reduce((s, e) => s + e.tokens, 0) / shareBase);
        bottomLines.push({ text: `● ${large.length} message${large.length > 1 ? 's use' : ' uses'} ${share} of context (each over 10%).`, style: { fg: t.accent } });
        bottomLines.push({ text: 'Run /compact to summarise and reduce context size.', style: { fg: t.textFaint } });
    }
    const hints: KitHint[] = [['↑↓', 'scroll']];
    const f = beginModal(screenWidth, screenHeight, { title: 'Context inspector', hints });
    const width = f.r - f.l + 1;
    let top = drawTextBlock(f.canvas, f.l, f.top, width, topLines, f.bottom) + 1;
    const bottomRows = bottomLines.length > 0 ? textBlockHeight(bottomLines, width) + 1 : 0;
    const listBottom = f.bottom - bottomRows;
    if (bottomRows > 0)
        drawTextBlock(f.canvas, f.l, listBottom + 2, width, bottomLines, f.bottom);
    const rows: KitRow[] = entries.map((e) => {
        const isLarge = e.tokens > largeThreshold;
        return {
            label: e.label,
            right: `${fmtPct(shareBase > 0 ? e.tokens / shareBase : 0)} · ~${fmtN(e.tokens)}`,
            mark: isLarge ? '●' : undefined,
            markFg: t.warning,
            labelFg: isLarge ? t.warning : undefined,
            bold: isLarge,
        };
    });
    // Open on the newest messages: find the first row of the tail that fits,
    // then step back by the modal's scroll position.
    if (top > listBottom)
        top = listBottom;
    const tailStart = listScrollEnd(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r });
    if (modal) {
        modal.maxScrollBack = tailStart;
        modal.scrollBack = Math.min(modal.scrollBack, tailStart);
    }
    const scrollStart = Math.max(0, tailStart - (modal?.scrollBack ?? 0));
    const res = drawList(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r, scrollStart });
    f.hintRight = scrollCountText(res.above, res.below);
    return finishModal(f);
}
