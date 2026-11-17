import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, readDocument, summarizeError, writeDocument } from '@goodvibes-jev/engine/platform/platform/utils';
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
    constructor(private getEntries: () => readonly string[]) { }
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
        return match?.entry ?? '';
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
type StoredInputHistoryEntry = string | {
    readonly text: string;
    readonly recallText?: string | undefined;
};
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
    private entries: StoredInputHistoryEntry[] = [];
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
     * Apply all active redaction rules to a text string.
     * Returns the scrubbed text (password arguments replaced with `<redacted>`).
     */
    private applyRedaction(text: string): string {
        let result = text;
        for (const rule of this.redactionRules) {
            result = result.replace(rule.pattern, rule.replacement);
        }
        return result;
    }
    /**
     * Add a new entry. Called on submit.
     * - Ignores empty/whitespace-only strings.
     * - Deduplicates consecutive identical entries.
     * - Applies redaction rules to scrub sensitive arguments before persistence.
     * - Resets browsing position.
     */
    add(text: string, options: {
        readonly recallText?: string | undefined;
    } = {}): void {
        const trimmed = this.applyRedaction(text.trim());
        if (!trimmed)
            return;
        const rawRecallText = options.recallText?.trim();
        const recallText = rawRecallText ? this.applyRedaction(rawRecallText) : undefined;
        const entry: StoredInputHistoryEntry = recallText && recallText !== trimmed
            ? { text: trimmed, recallText }
            : trimmed;
        // Lines another terminal saved go behind this one, so Up recalls what was
        // just typed here and the repeat check compares against the real neighbour.
        if (this.persist)
            this.mergeFromDisk();
        this.resetPosition();
        if (this.entries.length > 0 && this.sameEntry(this.entries[0]!, entry))
            return;
        this.entries.unshift(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries.length = this.maxEntries;
        }
        if (this.persist) {
            this.write();
        }
    }
    /**
     * Navigate up (older entry).
     * On first call, saves currentInput as draft.
     * Returns the entry to display, or null if at boundary.
     */
    up(currentInput: string): string | null {
        if (this.entries.length === 0)
            return null;
        // Save draft on first navigation
        if (this.position === -1) {
            this.draft = currentInput;
        }
        const next = this.position + 1;
        if (next < this.entries.length) {
            this.position = next;
            return this.getRecallText(this.entries[this.position]!);
        }
        // At oldest boundary
        return null;
    }
    /**
     * Navigate down (newer entry).
     * Returns newer entry, or draft when reaching the end.
     * Returns null if not currently browsing.
     */
    down(): string | null {
        if (this.position === -1)
            return null;
        const prev = this.position - 1;
        if (prev >= 0) {
            this.position = prev;
            return this.getRecallText(this.entries[this.position]!);
        }
        // Back to draft
        this.position = -1;
        return this.draft;
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
        return this.entries.map((entry) => this.getRecallText(entry));
    }
    /**
     * Save history to disk: entries another terminal added since this process
     * last read the file are merged in behind this process's newest line, then
     * the file is replaced whole.
     */
    save(): void {
        this.mergeFromDisk();
        this.write();
    }
    /**
     * Only the typed text is written. The recall text is the fully expanded
     * prompt (injected file bodies, pasted blocks), which can carry secrets and
     * is unbounded, so it lives in memory for this session only. Losing the
     * newest line to a power cut is acceptable for a history, so the write is
     * a plain replace (temp file and rename) with no directory sync.
     */
    private write(): void {
        try {
            const texts = this.entries.map((entry) => this.getDisplayText(entry));
            writeDocument(this.historyPath, texts, { indent: null });
            this.persistedTexts = new Set(texts);
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
        const known = new Set(this.entries.map((entry) => this.getDisplayText(entry)));
        const foreign: StoredInputHistoryEntry[] = [];
        for (const raw of parsed as unknown[]) {
            const entry = this.normalizeStoredEntry(raw);
            if (!entry)
                continue;
            const redacted = this.redactEntry(entry);
            const text = this.getDisplayText(redacted);
            if (known.has(text) || this.persistedTexts.has(text))
                continue;
            known.add(text);
            foreign.push(redacted);
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
                this.entries = parsed
                    .map((entry) => this.normalizeStoredEntry(entry))
                    .filter((entry): entry is StoredInputHistoryEntry => entry !== null)
                    .map((entry) => this.redactEntry(entry))
                    .slice(0, this.maxEntries);
                this.persistedTexts = new Set(this.entries.map((entry) => this.getDisplayText(entry)));
            }
        }
        catch (err) {
            logger.debug('InputHistory load failed (non-fatal, using empty history)', { error: summarizeError(err) });
            this.entries = [];
        }
    }
    private getDisplayText(entry: StoredInputHistoryEntry): string {
        return typeof entry === 'string' ? entry : entry.text;
    }
    private getRecallText(entry: StoredInputHistoryEntry): string {
        return typeof entry === 'string' ? entry : entry.recallText ?? entry.text;
    }
    private sameEntry(a: StoredInputHistoryEntry, b: StoredInputHistoryEntry): boolean {
        return this.getDisplayText(a) === this.getDisplayText(b)
            && this.getRecallText(a) === this.getRecallText(b);
    }
    /**
     * Apply redaction rules to a loaded entry, scrubbing any sensitive text that
     * was persisted before redaction was deployed.
     */
    private redactEntry(entry: StoredInputHistoryEntry): StoredInputHistoryEntry {
        if (typeof entry === 'string') {
            return this.applyRedaction(entry);
        }
        const redactedText = this.applyRedaction(entry.text);
        const redactedRecallText = entry.recallText !== undefined
            ? this.applyRedaction(entry.recallText)
            : undefined;
        if (redactedRecallText !== undefined && redactedRecallText !== redactedText) {
            return { text: redactedText, recallText: redactedRecallText };
        }
        return redactedText;
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
    private normalizeStoredEntry(entry: unknown): StoredInputHistoryEntry | null {
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
