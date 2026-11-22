import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, maskCredentialCandidates, readDocument, summarizeError, writeDocument } from '@goodvibes/engine/platform/platform/utils';
import { IMAGE_BLOCK_MARKER, TEXT_BLOCK_MARKER, type ComposerBlock, type ComposerMessage } from './input-content.js';
/**
 * InputHistory, Persisted command history with arrow-key navigation.
 *
 * Navigation model:
 *   position = -1   : not browsing (at the live draft)
 *   position = 0    : most recent entry
 *   position = N-1  : oldest visible entry
 *
 * Up arrow goes to older entries (position increases).
 * Down arrow goes to newer entries (position decreases), then back to draft.
 */
export interface HistorySearchMatch {
    entry: string;
    matchStart: number;
    matchLength: number;
}
export class HistorySearch {
    active = false;
    query = '';
    matches: HistorySearchMatch[] = [];
    matchIndex = 0;
    savedDraft = '';
    /**
     * `restore` turns an accepted entry into composer text: its pasted blocks
     * go back into the composer and their markers name them there.
     */
    constructor(private getEntries: () => readonly string[], private restore: (entry: string) => string) { }
    open(draft: string): void {
        this.active = true;
        this.savedDraft = draft;
        this.query = '';
        this.matches = [];
        this.matchIndex = 0;
    }
    search(query: string): void {
        this.query = query;
        const q = query.toLowerCase();
        this.matches = [];
        if (!q)
            return;
        for (const entry of this.getEntries()) {
            const idx = entry.toLowerCase().indexOf(q);
            if (idx >= 0) {
                this.matches.push({ entry, matchStart: idx, matchLength: q.length });
            }
        }
        this.matchIndex = 0;
    }
    appendChar(ch: string): void {
        this.search(this.query + ch);
    }
    deleteChar(): void {
        if (this.query.length > 0) {
            this.search(this.query.slice(0, -1));
        }
    }
    /** Move to next older match (higher index). */
    stepOlder(): void {
        if (this.matches.length > 0 && this.matchIndex < this.matches.length - 1) {
            this.matchIndex++;
        }
    }
    /** Move to next newer match (lower index). */
    stepNewer(): void {
        if (this.matchIndex > 0) {
            this.matchIndex--;
        }
    }
    get currentMatch(): HistorySearchMatch | null {
        return this.matches[this.matchIndex] ?? null;
    }
    accept(): string {
        const match = this.currentMatch;
        this.close();
        return match ? this.restore(match.entry) : '';
    }
    cancel(): string {
        const draft = this.savedDraft;
        this.close();
        return draft;
    }
    private close(): void {
        this.active = false;
        this.query = '';
        this.matches = [];
        this.matchIndex = 0;
        this.savedDraft = '';
    }
}
/**
 * A redaction rule applied to command text before it is stored or saved.
 * Any match of `pattern` in the raw text is replaced with `replacement`.
 */
export interface HistoryRedactionRule {
    readonly pattern: RegExp;
    readonly replacement: string;
}
/**
 * Built-in redaction rules that apply regardless of caller-supplied rules.
 * An executed command's secret arguments are redacted from its own
 * declaration (`secretArgs` on the command registration) before the line
 * gets here. These rules cover a line whose command is not registered on this
 * surface (the Agent has no `/local-auth`, and an unknown command line is
 * still kept so it can be recalled and corrected) and token flags typed
 * anywhere.
 */
const LOCAL_AUTH = String.raw`\/(?:auth\s+local|auth-local|local-auth)`;
const BUILTIN_REDACTION_RULES: readonly HistoryRedactionRule[] = [
    {
        // /auth local add-user <user> <password> [roles]
        pattern: new RegExp(String.raw`(${LOCAL_AUTH}\s+add-user\s+\S+)\s+(\S+)`, 'i'),
        replacement: '$1 <redacted>',
    },
    {
        // /auth local rotate-password <user> <password>
        pattern: new RegExp(String.raw`(${LOCAL_AUTH}\s+rotate-password\s+\S+)\s+(\S+)`, 'i'),
        replacement: '$1 <redacted>',
    },
    {
        // /auth local revoke-session <session-id-or-token>
        pattern: new RegExp(String.raw`(${LOCAL_AUTH}\s+revoke-session)\s+\S+`, 'i'),
        replacement: '$1 <redacted>',
    },
    {
        // /login service <daemon|listener> <baseUrl> <username> <password> [secretKey]
        pattern: /(\/login\s+service\s+\S+\s+\S+\s+\S+)\s+\S+/i,
        replacement: '$1 <redacted>',
    },
    {
        // /auth login <daemon|listener> <baseUrl> <username> <password> [secretKey]
        pattern: /(\/auth\s+login\s+\S+\s+\S+\s+\S+)\s+\S+/i,
        replacement: '$1 <redacted>',
    },
    {
        // --token, --bootstrap-token, --operator-token, --worker-client-token, --worker-token (space or = form).
        // The -ref and -env flags name a stored secret and stay readable.
        pattern: /(--(?:bootstrap-|operator-|worker-client-|worker-)?token)(?:\s+|=)\S+/gi,
        replacement: '$1 <redacted>',
    },
];
export interface InputHistoryOptions {
    /** Product storage identity; the history algorithm does not choose the product. */
    readonly surfaceRoot?: string | undefined;
    readonly historyPath?: string | undefined;
    readonly userRoot?: string | undefined;
    readonly homeDirectory?: string | undefined;
    readonly persist?: boolean | undefined;
    /** Additional redaction rules applied on top of the built-in set. */
    readonly redactionRules?: readonly HistoryRedactionRule[] | undefined;
}
/**
 * Pasted content kept for recall, counted over the newest lines first: as
 * much as one paste can hold (the tokenizer takes up to 8 MiB). Content of
 * older lines past it is let go, and those lines recall as their markers.
 */
const MAX_KEPT_BLOCK_CHARS = 8 * 1024 * 1024;
/** A content key: `h` and 16 hex digits of the block's SHA-256. */
const BLOCK_KEY = /^h[0-9a-f]{16}$/;
function blockKey(block: ComposerBlock): string {
    const hash = createHash('sha256');
    if (block.kind === 'text')
        hash.update('text\0').update(block.text);
    else
        hash.update(`image\0${block.mediaType}\0`).update(block.data);
    return `h${hash.digest('hex').slice(0, 16)}`;
}
function blockSize(block: ComposerBlock): number {
    return block.kind === 'text' ? block.text.length : block.data.length;
}
/** The content keys a line's markers name, text blocks first. */
function markerKeys(line: string): string[] {
    const keys: string[] = [];
    for (const match of line.matchAll(TEXT_BLOCK_MARKER))
        if (match[1] !== undefined && BLOCK_KEY.test(match[1])) keys.push(match[1]);
    for (const match of line.matchAll(IMAGE_BLOCK_MARKER))
        if (match[1] !== undefined && BLOCK_KEY.test(match[1])) keys.push(match[1]);
    return keys;
}
/**
 * The file's last element when any pasted text is kept: `{ "blocks": { key: text } }`.
 * A reader that knows only lines passes over it (it has no `text`).
 */
function readStoredBlocks(raw: unknown): Map<string, string> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'text' in raw)
        return null;
    const blocks = (raw as { readonly blocks?: unknown }).blocks;
    if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks))
        return null;
    const read = new Map<string, string>();
    for (const [key, text] of Object.entries(blocks))
        if (BLOCK_KEY.test(key) && typeof text === 'string') read.set(key, text);
    return read;
}
function resolveHistoryPath(options?: InputHistoryOptions | undefined): string {
    if (options?.historyPath) {
        return options.historyPath;
    }
    const userRoot = options?.userRoot ?? options?.homeDirectory;
    if (!userRoot) {
        throw new Error('InputHistory requires historyPath or an explicit userRoot/homeDirectory.');
    }
    const surfaceRoot = options?.surfaceRoot;
    if (!surfaceRoot) throw new Error('InputHistory requires an explicit product surfaceRoot when historyPath is absent.');
    return join(userRoot, '.goodvibes', surfaceRoot, 'input-history.json');
}
export class InputHistory {
    /** Each line as typed, newest first; a pasted block's marker names its content key in `blocks`. */
    private entries: string[] = [];
    /** Pasted content by content key, stored once however many lines name it. Images are kept for this run only. */
    private blocks = new Map<string, ComposerBlock>();
    private position = -1; // -1 = not browsing
    private draft = ''; // Saves current input when entering history
    private maxEntries = 500;
    private historyPath: string;
    private persist: boolean;
    private redactionRules: readonly HistoryRedactionRule[];
    /** Display texts this process last read from or wrote to the file; anything else on disk came from another process. */
    private persistedTexts = new Set<string>();
    constructor(options: InputHistoryOptions) {
        this.persist = options.persist ?? true;
        this.historyPath = resolveHistoryPath(options);
        this.redactionRules = [
            ...BUILTIN_REDACTION_RULES,
            ...(options.redactionRules ?? []),
        ];
        if (this.persist) {
            this.load();
        }
    }
    /**
     * Apply all active redaction rules to a text string, then mask every
     * credential-shaped span a rule did not name (maskCredentialCandidates: a
     * local pass, no request), so a token pasted into any line, a command's
     * undeclared argument or a message, is never stored.
     * Returns the scrubbed text (password arguments replaced with `<redacted>`).
     */
    private applyRedaction(text: string): string {
        let result = text;
        for (const rule of this.redactionRules) {
            result = result.replace(rule.pattern, rule.replacement);
        }
        return maskCredentialCandidates(result);
    }
    /**
     * Add a new entry. Called on submit.
     * - Ignores empty/whitespace-only strings.
     * - Deduplicates consecutive identical entries.
     * - Applies redaction rules to scrub sensitive arguments before persistence;
     *   pasted text goes through the same rules as typed text.
     * - Keeps each block of `blocks` (by its composer id in `text`) under a
     *   content key, and the line names that key in place of the composer id.
     * - Resets browsing position.
     */
    add(text: string, blocks: ReadonlyMap<string, ComposerBlock> = new Map()): void {
        const trimmed = this.applyRedaction(text.trim());
        if (!trimmed)
            return;
        const entry = this.keepBlocks(trimmed, blocks);
        // Lines another terminal saved go behind this one, so Up recalls what was
        // just typed here and the repeat check compares against the real neighbour.
        if (this.persist)
            this.mergeFromDisk();
        this.resetPosition();
        if (this.entries.length > 0 && this.entries[0] === entry)
            return;
        this.entries.unshift(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries.length = this.maxEntries;
        }
        this.releaseBlocks();
        if (this.persist) {
            this.write();
        }
    }
    /**
     * A stored line as the composer takes it back: its text and the content of
     * each block its markers name. A marker whose content is not kept (a line
     * saved with its marker only, or one past the kept size) has no block.
     */
    recall(line: string): ComposerMessage {
        const blocks = new Map<string, ComposerBlock>();
        for (const key of markerKeys(line)) {
            const block = this.blocks.get(key);
            if (block)
                blocks.set(key, block);
        }
        return { text: line, blocks };
    }
    /**
     * Navigate up (older entry).
     * On first call, saves currentInput as draft.
     * Returns the entry to display, or null if at boundary.
     */
    up(currentInput: string): ComposerMessage | null {
        if (this.entries.length === 0)
            return null;
        // Save draft on first navigation
        if (this.position === -1) {
            this.draft = currentInput;
        }
        const next = this.position + 1;
        if (next < this.entries.length) {
            this.position = next;
            return this.recall(this.entries[this.position]!);
        }
        // At oldest boundary
        return null;
    }
    /**
     * Navigate down (newer entry).
     * Returns newer entry, or draft when reaching the end.
     * Returns null if not currently browsing.
     */
    down(): ComposerMessage | null {
        if (this.position === -1)
            return null;
        const prev = this.position - 1;
        if (prev >= 0) {
            this.position = prev;
            return this.recall(this.entries[this.position]!);
        }
        // Back to draft: its blocks are still in the composer's registries.
        this.position = -1;
        return { text: this.draft, blocks: new Map() };
    }
    /**
     * Reset browsing position. Called when user types new text.
     */
    resetPosition(): void {
        this.position = -1;
        this.draft = '';
    }
    /**
     * Whether currently browsing history.
     */
    get isBrowsing(): boolean {
        return this.position !== -1;
    }
    /**
     * Return entries as readonly for use by HistorySearch.
     */
    getEntries(): readonly string[] {
        return this.entries;
    }
    /**
     * Save history to disk: entries another terminal added since this process
     * last read the file are merged in behind this process's newest line, then
     * the file is replaced whole.
     */
    save(): void {
        this.mergeFromDisk();
        this.releaseBlocks();
        this.write();
    }
    /**
     * The file is a JSON list of the lines as typed, newest first, then, when
     * any pasted text is kept, one `{ "blocks": { key: text } }` element with
     * that text, redacted like the lines and stored once per content. A
     * referenced file is not written: `@path` is read again when the line is
     * sent again. Pasted images stay in memory for this run. Losing the newest
     * line to a power cut is acceptable for a history, so the write is a plain
     * replace (temp file and rename) with no directory sync.
     */
    private write(): void {
        try {
            const kept: Record<string, string> = {};
            let anyKept = false;
            for (const [key, block] of this.blocks) {
                if (block.kind !== 'text')
                    continue;
                kept[key] = block.text;
                anyKept = true;
            }
            const stored: unknown[] = anyKept ? [...this.entries, { blocks: kept }] : [...this.entries];
            writeDocument(this.historyPath, stored, { indent: null });
            this.persistedTexts = new Set(this.entries);
        }
        catch (err) {
            logger.debug('InputHistory save failed (non-fatal)', { error: summarizeError(err) });
        }
    }
    /** One read of the file. A file that turned unreadable since this process opened it is replaced by the next write. */
    private mergeFromDisk(): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(this.historyPath, 'utf-8'));
        }
        catch {
            return;
        }
        if (!Array.isArray(parsed))
            return;
        const known = new Set(this.entries);
        const foreign: string[] = [];
        for (const raw of parsed as unknown[]) {
            const stored = readStoredBlocks(raw);
            if (stored) {
                this.takeStoredBlocks(stored);
                continue;
            }
            const entry = this.normalizeStoredEntry(raw);
            if (!entry)
                continue;
            const text = this.applyRedaction(entry);
            if (known.has(text) || this.persistedTexts.has(text))
                continue;
            known.add(text);
            foreign.push(text);
        }
        if (foreign.length > 0) {
            this.entries = [...foreign, ...this.entries].slice(0, this.maxEntries);
        }
    }
    /**
     * Load history from disk. An unreadable file is moved aside (with a note
     * saying why) by the platform's document reader and history starts empty.
     *
     * Redaction is applied to every loaded entry so that cleartext passwords
     * persisted before the redaction rules were deployed are scrubbed on first
     * load and will not be re-persisted on the next save().
     */
    load(): void {
        try {
            const parsed = readDocument(this.historyPath, {
                label: 'input-history',
                recovery: 'Input history starts empty; lines typed from now on are kept.',
                validate: (value: unknown): unknown[] => {
                    if (!Array.isArray(value))
                        throw new Error('input history is not a list');
                    return value;
                },
            });
            if (parsed) {
                const entries: string[] = [];
                for (const raw of parsed) {
                    const stored = readStoredBlocks(raw);
                    if (stored) {
                        this.takeStoredBlocks(stored);
                        continue;
                    }
                    const entry = this.normalizeStoredEntry(raw);
                    if (entry !== null)
                        entries.push(this.applyRedaction(entry));
                }
                this.entries = entries.slice(0, this.maxEntries);
                this.persistedTexts = new Set(this.entries);
                this.releaseBlocks();
            }
        }
        catch (err) {
            logger.debug('InputHistory load failed (non-fatal, using empty history)', { error: summarizeError(err) });
            this.entries = [];
            this.blocks.clear();
        }
    }
    /**
     * The line as kept: each marker whose composer id has a block in `blocks`
     * names the block's content key instead, and the block, its text redacted
     * as a typed line is, is kept under that key.
     */
    private keepBlocks(line: string, blocks: ReadonlyMap<string, ComposerBlock>): string {
        if (blocks.size === 0)
            return line;
        const keyFor = (id: string, kind: ComposerBlock['kind']): string | undefined => {
            const block = blocks.get(id);
            if (!block || block.kind !== kind)
                return undefined;
            const kept: ComposerBlock = block.kind === 'text' ? { kind: 'text', text: this.applyRedaction(block.text) } : block;
            const key = blockKey(kept);
            this.blocks.set(key, kept);
            return key;
        };
        return line
            .replace(TEXT_BLOCK_MARKER, (marker: string, id: string, lines: string) => {
                const key = keyFor(id, 'text');
                return key === undefined ? marker : `[TEXT: ${key}, ${lines} lines]`;
            })
            .replace(IMAGE_BLOCK_MARKER, (marker: string, id: string, label: string) => {
                const key = keyFor(id, 'image');
                return key === undefined ? marker : `[IMAGE: ${key}, ${label}]`;
            });
    }
    /** Pasted text read from the file, redacted again as loaded lines are; content already held is kept as is. */
    private takeStoredBlocks(stored: ReadonlyMap<string, string>): void {
        for (const [key, text] of stored)
            if (!this.blocks.has(key))
                this.blocks.set(key, { kind: 'text', text: this.applyRedaction(text) });
    }
    /**
     * Keeps the content the newest lines name, up to MAX_KEPT_BLOCK_CHARS, and
     * lets go of the rest: content no kept line names, and content of older
     * lines that does not fit.
     */
    private releaseBlocks(): void {
        const kept = new Set<string>();
        let size = 0;
        for (const entry of this.entries) {
            for (const key of markerKeys(entry)) {
                const block = this.blocks.get(key);
                if (!block || kept.has(key))
                    continue;
                if (size + blockSize(block) > MAX_KEPT_BLOCK_CHARS)
                    continue;
                size += blockSize(block);
                kept.add(key);
            }
        }
        for (const key of [...this.blocks.keys()])
            if (!kept.has(key))
                this.blocks.delete(key);
    }
    /**
     * Entries persisted before CR normalization was deployed (registerPaste now
     * converts the \r line separators terminals send in bracketed pastes to \n)
     * may still carry literal \r bytes; launder them on load so history recall
     * cannot reintroduce \r into the composer.
     */
    private launderLineBreaks(text: string): string {
        return text.replace(/\r\n?/g, '\n');
    }
    private normalizeStoredEntry(entry: unknown): string | null {
        if (typeof entry === 'string')
            return this.launderLineBreaks(entry);
        if (!entry || typeof entry !== 'object')
            return null;
        const record = entry as Record<string, unknown>;
        if (typeof record.text !== 'string')
            return null;
        const text = this.launderLineBreaks(record.text).trim();
        if (!text)
            return null;
        // Older files stored the expanded prompt as recallText; it is never read back.
        return text;
    }
}
