import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger, maskCredentialCandidates, readDocument, summarizeError, writeDocument, writeFileAtomic } from '@goodvibes/engine/platform/platform/utils';
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
 * declaration (`secretArgs` on the command registration, made from the
 * secret inputs of its actions) before the line gets here, so every command a
 * person can still type that takes a secret is masked by what it declares.
 * The one rule here covers token flags typed anywhere. The commands that once
 * took a password on the line (`/auth local`, `/local-auth`, `/login service`,
 * `/auth login`) are gone; their acts take the password on a hidden line.
 */
const BUILTIN_REDACTION_RULES: readonly HistoryRedactionRule[] = [
    {
        // --token, --bootstrap-token, --operator-token, --worker-client-token, --worker-token (space or = form).
        // The -ref and -env flags name a stored secret and stay readable.
        pattern: /(--(?:bootstrap-|operator-|worker-client-|worker-)?token)(?:\s+|=)\S+/gi,
        replacement: '$1 <redacted>',
    },
];
/** The words of a secret-setting line that are options and not the value. */
const SECRET_SETTING_OPTIONS: ReadonlySet<string> = new Set(['--user', '--project', '--secure', '--plaintext', '--yes']);
/**
 * A typed `/secrets set KEY value ...` line with the value taken out, whether or not the value looks like a credential:
 * the key and the options stay, every other word after the key becomes one `<redacted>`. Any other line is returned as
 * it is. A line whose key is left out (`/secrets set`, which asks for the value on a hidden line) has no value to take out.
 */
function maskSecretSettingLine(text: string): string {
    const start = /^(\s*\/secrets\s+set)(\s+|$)/i.exec(text);
    if (!start)
        return text;
    const words = text.slice(start[0].length).split(/\s+/).filter((word) => word !== '');
    const kept: string[] = [];
    let key = false;
    let masked = false;
    for (const word of words) {
        if (SECRET_SETTING_OPTIONS.has(word.toLowerCase())) {
            kept.push(word);
        }
        else if (!key) {
            key = true;
            kept.push(word);
        }
        else if (!masked) {
            masked = true;
            kept.push('<redacted>');
        }
    }
    return [start[1]!.trim(), ...kept].join(' ');
}
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
 * Pasted content kept for recall, counted over the newest lines first, for
 * text and for images apart: as much as one paste can hold (the tokenizer
 * takes up to 8 MiB). Content of older lines past it is let go, and those
 * lines recall as their markers.
 */
const MAX_KEPT_BLOCK_CHARS = 8 * 1024 * 1024;
/**
 * A content key: `h`, 16 hex digits of the block's SHA-256, `-` and its size
 * in characters. The size in the key lets the bound be kept from the list of
 * lines alone, with no file read.
 */
const BLOCK_KEY = /^h[0-9a-f]{16}-\d+$/;
function blockSize(block: ComposerBlock): number {
    return block.kind === 'text' ? block.text.length : block.data.length;
}
function blockKey(block: ComposerBlock): string {
    const hash = createHash('sha256');
    if (block.kind === 'text')
        hash.update('text\0').update(block.text);
    else
        hash.update(`image\0${block.mediaType}\0`).update(block.data);
    return `h${hash.digest('hex').slice(0, 16)}-${blockSize(block)}`;
}
function keySize(key: string): number {
    return Number(key.slice(key.indexOf('-') + 1));
}
/** The content keys a line's markers name, with the kind of block each marker is. */
function markerKeys(line: string): { readonly key: string; readonly kind: ComposerBlock['kind'] }[] {
    const keys: { readonly key: string; readonly kind: ComposerBlock['kind'] }[] = [];
    for (const match of line.matchAll(TEXT_BLOCK_MARKER))
        if (match[1] !== undefined && BLOCK_KEY.test(match[1])) keys.push({ key: match[1], kind: 'text' });
    for (const match of line.matchAll(IMAGE_BLOCK_MARKER))
        if (match[1] !== undefined && BLOCK_KEY.test(match[1])) keys.push({ key: match[1], kind: 'image' });
    return keys;
}
/** The keys of one kind the newest lines name, newest first, up to MAX_KEPT_BLOCK_CHARS; an older one that does not fit is left out. */
function keptKeys(lines: readonly string[], kind: ComposerBlock['kind']): Set<string> {
    const kept = new Set<string>();
    let size = 0;
    for (const line of lines) {
        for (const named of markerKeys(line)) {
            if (named.kind !== kind || kept.has(named.key))
                continue;
            const next = size + keySize(named.key);
            if (next > MAX_KEPT_BLOCK_CHARS)
                continue;
            size = next;
            kept.add(named.key);
        }
    }
    return kept;
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
    /** Each line as typed, newest first; a pasted block's marker names its content key. */
    private entries: string[] = [];
    /** Pasted text this run wrote or read, by content key; the files in `pasteDir` are its record. */
    private texts = new Map<string, string>();
    /** Pasted images by content key, kept for this run only. */
    private images = new Map<string, ComposerBlock>();
    /** The text keys within the bound at the last write or load: each has its file in `pasteDir`. */
    private storedTextKeys = new Set<string>();
    private position = -1; // -1 = not browsing
    private draft = ''; // Saves current input when entering history
    private maxEntries = 500;
    private historyPath: string;
    /** `input-history-pastes/` beside the history file: one `<key>.txt` per pasted text, written once. */
    private pasteDir: string;
    private pasteDirMade = false;
    private persist: boolean;
    private redactionRules: readonly HistoryRedactionRule[];
    /** Display texts this process last read from or wrote to the file; anything else on disk came from another process. */
    private persistedTexts = new Set<string>();
    constructor(options: InputHistoryOptions) {
        this.persist = options.persist ?? true;
        this.historyPath = resolveHistoryPath(options);
        this.pasteDir = join(dirname(this.historyPath), 'input-history-pastes');
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
        let result = maskSecretSettingLine(text);
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
        this.write();
    }
    /**
     * A stored line as the composer takes it back: its text and the content of
     * each block its markers name. Pasted text not yet read this run is read
     * now from its own file, and only for the keys this line names. A marker
     * whose content is not kept (a line saved with its marker only, or one
     * past the kept size) has no block.
     */
    recall(line: string): ComposerMessage {
        const blocks = new Map<string, ComposerBlock>();
        for (const { key, kind } of markerKeys(line)) {
            if (kind === 'image') {
                const image = this.images.get(key);
                if (image)
                    blocks.set(key, image);
                continue;
            }
            const text = this.texts.get(key) ?? this.readPaste(key);
            if (text !== undefined)
                blocks.set(key, { kind: 'text', text });
        }
        return { text: line, blocks };
    }
    private pastePath(key: string): string {
        return join(this.pasteDir, `${key}.txt`);
    }
    /** One kept paste's text, read from its file and redacted again as loaded lines are. */
    private readPaste(key: string): string | undefined {
        if (!this.persist || !this.storedTextKeys.has(key))
            return undefined;
        try {
            const text = this.applyRedaction(readFileSync(this.pastePath(key), 'utf-8'));
            this.texts.set(key, text);
            return text;
        }
        catch (err) {
            logger.debug('InputHistory paste read failed (the line recalls as its marker)', { error: summarizeError(err) });
            return undefined;
        }
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
        if (this.persist)
            this.mergeFromDisk();
        this.write();
    }
    /**
     * The history file is a JSON list of the lines as typed, newest first,
     * the only file rewritten on each send. Each pasted text lives in its own
     * file, `input-history-pastes/<key>.txt`, redacted like the lines and
     * written once, by the write whose list first names its key within the
     * bound; a send with no new paste writes no paste file. A paste file no
     * kept line names any more (its line dropped past 500, or its text past
     * the bound) is removed, by its own path, by the write that drops it. A
     * referenced file is not written: `@path` is read again when the line is
     * sent again. Pasted images stay in memory for this run. Losing the newest
     * line to a power cut is acceptable for a history, so the list is a plain
     * replace (temp file and rename) with no directory sync.
     */
    private write(): void {
        const stored = keptKeys(this.entries, 'text');
        const images = keptKeys(this.entries, 'image');
        for (const key of [...this.images.keys()])
            if (!images.has(key))
                this.images.delete(key);
        if (!this.persist) {
            for (const key of [...this.texts.keys()])
                if (!stored.has(key))
                    this.texts.delete(key);
            return;
        }
        try {
            // Content before the list that names it, so a line on disk never names text not yet written.
            for (const key of stored) {
                const text = this.texts.get(key);
                if (this.storedTextKeys.has(key) || text === undefined)
                    continue;
                if (!this.pasteDirMade) {
                    mkdirSync(this.pasteDir, { recursive: true, mode: 0o700 });
                    this.pasteDirMade = true;
                }
                writeFileAtomic(this.pastePath(key), text, { mode: 0o600, cleanupStaleTemps: false });
            }
            writeDocument(this.historyPath, this.entries, { indent: null });
            this.persistedTexts = new Set(this.entries);
        }
        catch (err) {
            logger.debug('InputHistory save failed (non-fatal)', { error: summarizeError(err) });
            return;
        }
        for (const key of this.storedTextKeys) {
            if (stored.has(key))
                continue;
            this.texts.delete(key);
            try {
                unlinkSync(this.pastePath(key));
            }
            catch (err) {
                logger.debug('InputHistory paste removal failed (non-fatal)', { error: summarizeError(err) });
            }
        }
        for (const key of [...this.texts.keys()])
            if (!stored.has(key))
                this.texts.delete(key);
        this.storedTextKeys = stored;
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
                    const entry = this.normalizeStoredEntry(raw);
                    if (entry !== null)
                        entries.push(this.applyRedaction(entry));
                }
                this.entries = entries.slice(0, this.maxEntries);
                this.persistedTexts = new Set(this.entries);
                // From the list alone: no paste file is read until its line is recalled.
                this.storedTextKeys = keptKeys(this.entries, 'text');
            }
        }
        catch (err) {
            logger.debug('InputHistory load failed (non-fatal, using empty history)', { error: summarizeError(err) });
            this.entries = [];
            this.storedTextKeys = new Set();
        }
    }
    /**
     * The line as kept: each marker whose composer id has a block in `blocks`
     * names the block's content key instead, and the block, its text redacted
     * as a typed line is, is held under that key until the write stores it.
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
            if (kept.kind === 'text')
                this.texts.set(key, kept.text);
            else
                this.images.set(key, kept);
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
