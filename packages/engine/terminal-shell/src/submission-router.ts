import type { SubmissionIntent } from './submission-intent.js';
export interface SubmissionRouterInput {
    readonly text: string;
    readonly commandMode?: boolean | undefined;
    readonly hasAttachments?: boolean | undefined;
}
export interface SubmissionCommandRule {
    readonly commands: readonly string[];
    readonly kind: SubmissionIntent['kind'];
    readonly label: string;
}
/**
 * The composer's own markers, read once from the text the person typed: `!#`
 * pins to session memory and sends, `!` runs a shell command, a one-line `# `
 * saves a note without sending. Leading whitespace is ignored. Both terminal
 * apps label the composer and dispatch Enter from this one reading.
 */
export type ComposerMarker =
    | { readonly kind: 'shell'; readonly body: string }
    | { readonly kind: 'memory-pin'; readonly body: string }
    | { readonly kind: 'note'; readonly body: string }
    | { readonly kind: 'none' };
export function readComposerMarker(text: string): ComposerMarker {
    const leading = text.replace(/^\s+/, '');
    if (leading.startsWith('!#'))
        return { kind: 'memory-pin', body: leading.slice(2).trim() };
    if (leading.startsWith('!'))
        return { kind: 'shell', body: leading.slice(1).trim() };
    // The space keeps `#482 is failing` (an issue number) and `##` headings as
    // prompts; a note is one line.
    if ((leading === '#' || leading.startsWith('# ')) && !leading.trimEnd().includes('\n'))
        return { kind: 'note', body: leading.slice(1).trim() };
    return { kind: 'none' };
}
const LEADING_AT_MODEL = /^@model:(\S+)(?:\s+|$)/;
const TRAILING_AT_MODEL = /\s+@model:(\S+)$/;
/**
 * The `@model:<id>` switch, part of the composer's grammar in both terminal
 * apps: a whole token at the start or at the end of typed text
 * (`@model:opus summarize this`, `summarize this @model:opus`). Text that only
 * contains `@model:` elsewhere (an `scp user@model:/srv` line, a pasted log)
 * is sent as written. `take` switches to one id and says whether it did; a
 * token it refuses (an id that names no model) stays in the text, so nothing
 * typed disappears. Returns the ids taken, in order, and the text without
 * them; the input unchanged when none was taken. Text that is not typed into
 * the composer (forms, speech, skill bodies, retries) never comes here.
 */
export function splitAtModelDirectives(input: string, take: (model: string) => boolean = () => true): { readonly models: readonly string[]; readonly text: string } {
    let text = input.trim();
    const models: string[] = [];
    const leading = LEADING_AT_MODEL.exec(text);
    if (leading && take(leading[1]!)) {
        models.push(leading[1]!);
        text = text.slice(leading[0].length);
    }
    const trailing = TRAILING_AT_MODEL.exec(text);
    if (trailing && take(trailing[1]!)) {
        models.push(trailing[1]!);
        text = text.slice(0, trailing.index);
    }
    return { models, text: models.length > 0 ? text.trim() : input };
}
export interface ComposerCaptureDeps {
    readonly sessionMemoryStore: { add(text: string): string };
    /** Shows the confirmation or usage line. */
    readonly notify: (message: string) => void;
}
export interface ComposerCaptureResult {
    /** Text to continue the submission with (empty when nothing should be sent). */
    readonly text: string;
    /** Whether a memory pin or note marker was handled. */
    readonly captured: boolean;
}
/**
 * Applies the memory markers: `!# <text>` pins <text> and sends it as the
 * prompt; `# <text>` saves a note and sends nothing. A shell marker is the
 * caller's to run before this; any other text comes back unchanged.
 */
export function applyComposerCapture(input: string, deps: ComposerCaptureDeps): ComposerCaptureResult {
    const marker = readComposerMarker(input);
    if (marker.kind === 'memory-pin') {
        if (!marker.body) {
            deps.notify('[Memory] Usage: !# <text to pin as session memory>');
            return { text: '', captured: true };
        }
        const id = deps.sessionMemoryStore.add(marker.body);
        deps.notify(`[Memory] Pinned: "${marker.body}" (${id})`);
        return { text: marker.body, captured: true };
    }
    if (marker.kind === 'note') {
        if (!marker.body) {
            deps.notify('[Note] Usage: # <text to save as a session-memory note>');
            return { text: '', captured: true };
        }
        const id = deps.sessionMemoryStore.add(marker.body);
        const chip = marker.body.length > 60 ? `${marker.body.slice(0, 57)}...` : marker.body;
        deps.notify(`✓ Note saved → session memory: "${chip}" (${id})`);
        return { text: '', captured: true };
    }
    return { text: input, captured: false };
}
/**
 * Whether a submission goes out after its markers were handled. A handled
 * marker that left no text (a saved note, a usage hint) consumes the whole
 * submission, so attached content is not sent on its own.
 */
export function shouldSendAfterCapture(capture: ComposerCaptureResult, hasContent: boolean): boolean {
    if (capture.captured && capture.text === '')
        return false;
    return capture.text !== '' || hasContent;
}
/** Product command vocabularies are data; prefix parsing and routing have one owner. */
export function createSubmissionRouter(rules: readonly SubmissionCommandRule[]): (input: SubmissionRouterInput) => SubmissionIntent {
    const commands = new Map(rules.flatMap(rule => rule.commands.map(command => [command, { kind: rule.kind, label: rule.label }] as const)));
    return input => routeSubmissionIntent(input, commands);
}
export function routeSubmissionIntent(input: SubmissionRouterInput, commands: ReadonlyMap<string, Pick<SubmissionIntent, 'kind' | 'label'>>): SubmissionIntent {
    const trimmed = input.text.trim();
    const hasAttachments = input.hasAttachments ?? false;
    if (!trimmed) {
        return { kind: 'empty', label: 'prompt', hasAttachments };
    }
    const marker = readComposerMarker(input.text);
    if (marker.kind === 'memory-pin')
        return { kind: 'memory-pin', label: 'memory pin', hasAttachments };
    if (marker.kind === 'shell')
        return { kind: 'shell', label: 'shell', hasAttachments };
    if (marker.kind === 'note')
        return { kind: 'note', label: 'note', hasAttachments };
    if (input.commandMode || trimmed.startsWith('/')) {
        const commandName = trimmed.replace(/^\//, '').split(/\s+/, 1)[0] ?? '';
        const match = commands.get(commandName);
        if (match)
            return { ...match, commandName, hasAttachments };
        return { kind: 'slash-command', label: 'command', commandName, hasAttachments };
    }
    return { kind: 'prompt', label: 'prompt', hasAttachments };
}
