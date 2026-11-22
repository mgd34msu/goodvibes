import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import type { ContentPart } from '@goodvibes/engine/platform/platform/providers';
import { logger, summarizeError, resolveAndValidatePath, requireDefined } from '@goodvibes/engine/platform/platform/utils';
import { pasteImageFromClipboard, pasteFromClipboard } from './clipboard.js';
import { MAX_IMAGE_ATTACH_BYTES } from './modal-input-routes.js';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
const URL_REFERENCE_REGEX = /^https?:\/\/[^\s]+$/i;
const CONTEXT_REFERENCE_TRAILING_PUNCTUATION = /[),.;:!?]+$/;
function stripTrailingReferencePunctuation(value: string): {
    readonly core: string;
    readonly suffix: string;
} {
    const match = CONTEXT_REFERENCE_TRAILING_PUNCTUATION.exec(value);
    if (!match)
        return { core: value, suffix: '' };
    return {
        core: value.slice(0, -match[0].length),
        suffix: match[0],
    };
}
function escapeContextAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** One referenced file is cut at the size the read tool returns by default (25,000 tokens). */
const MAX_REFERENCE_CHARS = 100_000;
/** The most of a referenced text file that is read: enough bytes for the kept characters at four bytes each. */
const MAX_REFERENCE_READ_BYTES = MAX_REFERENCE_CHARS * 4;
/**
 * Cuts referenced text to the kept size. With `file`, the text is the start of
 * a file of `file.bytes` bytes, read only in part when `file.partial`, and the
 * cut is reported against the file's size.
 */
function capReferenceText(content: string, label: string, file?: { readonly bytes: number; readonly partial: boolean }): string {
    if (content.length <= MAX_REFERENCE_CHARS && file?.partial !== true)
        return content;
    let keep = content.length;
    if (content.length > MAX_REFERENCE_CHARS) {
        const lineEnd = content.lastIndexOf('\n', MAX_REFERENCE_CHARS);
        keep = lineEnd > MAX_REFERENCE_CHARS * 0.8 ? lineEnd : MAX_REFERENCE_CHARS;
    }
    const whole = file ? `${file.bytes} bytes` : `${content.length} characters`;
    return `${content.slice(0, keep)}\n[${label} cut: kept the first ${keep} characters of ${whole}. Ask for the rest with the read tool.]`;
}
/** The length of `bytes` without a UTF-8 sequence cut off at its end. */
function completeUtf8Length(bytes: Buffer): number {
    let start = bytes.length - 1;
    // Step back over continuation bytes (10xxxxxx) to the lead byte of the last sequence.
    while (start >= 0 && start > bytes.length - 4 && ((bytes[start] ?? 0) & 0xC0) === 0x80)
        start -= 1;
    if (start < 0)
        return bytes.length;
    const lead = bytes[start] ?? 0;
    const needed = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    return bytes.length - start < needed ? start : bytes.length;
}
/** A referenced path the user typed that exists but cannot be read is a refusal, not silent text. */
function referenceFailure(reference: string, error: unknown): PromptReferenceFailure {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
    const reason = code === 'ENOENT' ? 'no such file' : code === 'EACCES' || code === 'EPERM' ? 'permission denied'
        : code === 'EISDIR' ? 'it is a folder' : error instanceof BinaryReferenceError ? error.message : summarizeError(error);
    return { reference, reason };
}
/** An image the user typed a reference to; it is sent as an image part, never as text. */
interface ReferencedImage {
    readonly data: string;
    readonly mediaType: string;
    readonly name: string;
    readonly bytes: number;
}
type AttachReferencedImage = (image: ReferencedImage) => string;
class BinaryReferenceError extends Error {
}
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
/** The image type of a file's bytes, judged from its leading bytes alone; undefined for anything else. */
export function imageMediaType(bytes: Buffer): string | undefined {
    for (const { magic, mediaType, extraCheck } of BINARY_IMAGE_MAGIC) {
        if (bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b) && (!extraCheck || extraCheck(bytes)))
            return mediaType;
    }
    return undefined;
}
/**
 * Reads a file the user referenced in the prompt. An image (by its bytes, not
 * its name) is handed to `attachImage` and its marker returned; any other file
 * that is not UTF-8 text is refused: its bytes never reach the model as text.
 */
/** Whether the file at a referenced path is an image, read from its first bytes only. */
export function isImageFile(resolvedPath: string): boolean {
    let fd: number | undefined;
    try {
        fd = openSync(resolvedPath, 'r');
        const head = Buffer.alloc(12);
        return imageMediaType(head.subarray(0, readSync(fd, head, 0, 12, 0))) !== undefined;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** Reads up to `length` bytes from the start of an open file. */
function readHead(fd: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
        const read = readSync(fd, buffer, filled, length - filled, filled);
        if (read === 0)
            break;
        filled += read;
    }
    return buffer.subarray(0, filled);
}
/** Opening without blocking: a FIFO named by a reference is refused after its fstat, not waited on. */
const OPEN_REFERENCE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
function readReferencedFile(resolvedPath: string, attachImage: AttachReferencedImage): { readonly kind: 'text'; readonly text: string; readonly bytes: number; readonly partial: boolean } | { readonly kind: 'image'; readonly marker: string } {
    // One open serves the type check, the size check and the read, so nothing is read before both checks.
    const fd = openSync(resolvedPath, OPEN_REFERENCE_FLAGS);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
            throw new BinaryReferenceError(stat.isDirectory() ? 'it is a folder' : 'not a regular file');
        const head = readHead(fd, Math.min(12, stat.size));
        const mediaType = imageMediaType(head);
        if (mediaType) {
            if (stat.size > MAX_IMAGE_ATTACH_BYTES)
                throw new BinaryReferenceError(`an image larger than ${formatFileSize(MAX_IMAGE_ATTACH_BYTES)} is not sent`);
            const bytes = readHead(fd, stat.size);
            return { kind: 'image', marker: attachImage({ data: bytes.toString('base64'), mediaType, name: basename(resolvedPath), bytes: bytes.length }) };
        }
        const bytes = readHead(fd, Math.min(stat.size, MAX_REFERENCE_READ_BYTES));
        if (bytes.subarray(0, 8192).includes(0))
            throw new BinaryReferenceError('a binary file is not sent as text; images are PNG, JPEG, WebP or GIF');
        const partial = bytes.length < stat.size;
        try {
            return { kind: 'text', text: UTF8_STRICT.decode(partial ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes), bytes: stat.size, partial };
        }
        catch {
            throw new BinaryReferenceError('the file is not UTF-8 text and is not sent');
        }
    }
    finally {
        closeSync(fd);
    }
}
function readContextFileBlock(reference: string, projectRoot: string, failures: PromptReferenceFailure[], attachImage: AttachReferencedImage): string | null {
    let resolvedPath: string;
    try {
        resolvedPath = resolveAndValidatePath(reference, projectRoot);
    }
    catch (error) {
        logger.debug('expandPrompt: context reference rejected', { reference, error: summarizeError(error) });
        return null;
    }
    if (!existsSync(resolvedPath))
        return null;
    try {
        const stat = lstatSync(resolvedPath);
        const label = escapeContextAttribute(relative(projectRoot, resolvedPath) || basename(resolvedPath));
        if (stat.isDirectory()) {
            const entries = readdirSync(resolvedPath, { withFileTypes: true })
                .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
                .join('\n');
            return [`<context-folder path="${label}">`, capReferenceText(entries || '(empty directory)', 'Folder listing'), '</context-folder>'].join('\n');
        }
        if (!stat.isFile())
            return null;
        const file = readReferencedFile(resolvedPath, attachImage);
        if (file.kind === 'image')
            return file.marker;
        return [
            `<context-file path="${label}" bytes="${file.bytes}">`,
            capReferenceText(file.text, 'File', file),
            '</context-file>',
        ].join('\n');
    }
    catch (error) {
        failures.push(referenceFailure(`@${reference}`, error));
        return null;
    }
}
function buildContextUrlBlock(reference: string): string {
    const href = escapeContextAttribute(reference);
    return [
        `<context-url href="${href}">`,
        'The user referenced this URL in the prompt. Use connected tools only if content retrieval is needed; do not ingest it into Agent Knowledge unless the user explicitly asks.',
        '</context-url>',
    ].join('\n');
}
export interface PromptReferenceFailure {
    readonly reference: string;
    readonly reason: string;
}
const TYPED_REFERENCE_REGEX = /(^|\s)(!@|@)(\S+)/g;
/**
 * Expand the references the user typed, in one pass over the typed text:
 * `!@path` becomes the file's text and, when `contextReferences` is on,
 * `@path` becomes a context block and `@https://...` a URL note. A referenced
 * image becomes an image marker (sent as an image part); another binary file
 * is a failure, never text. Replaced
 * content is never scanned again, so a file cannot pull in other files. An
 * `!@` file that cannot be read, or an `@` path that exists but cannot be
 * read, is returned as a failure; an `@word` that names nothing stays text.
 */
function expandTypedReferences(text: string, projectRoot: string, contextReferences: boolean, failures: PromptReferenceFailure[], attachImage: AttachReferencedImage): string {
    return text.replace(TYPED_REFERENCE_REGEX, (full: string, prefix: string, marker: string, rawReference: string): string => {
        if (marker === '!@') {
            try {
                const resolvedPath = resolveAndValidatePath(rawReference, projectRoot);
                const file = readReferencedFile(resolvedPath, attachImage);
                return `${prefix}${file.kind === 'image' ? file.marker : capReferenceText(file.text, 'File', file)}`;
            }
            catch (error) {
                failures.push(referenceFailure(`!@${rawReference}`, error));
                return full;
            }
        }
        if (!contextReferences || rawReference.startsWith('model:'))
            return full;
        const { core, suffix } = stripTrailingReferencePunctuation(rawReference);
        if (!core || core.startsWith('@'))
            return full;
        if (URL_REFERENCE_REGEX.test(core)) {
            return `${prefix}${buildContextUrlBlock(core)}${suffix}`;
        }
        const fileBlock = readContextFileBlock(core, projectRoot, failures, attachImage);
        if (!fileBlock)
            return full;
        return `${prefix}${fileBlock}${suffix}`;
    });
}
/**
 * Says, once, that a bracketed paste over the size limit was not inserted:
 * the tokenizer drops it whole, so without this line the paste just does not
 * appear. A host calls it after each tokenizer feed.
 */
export function reportDroppedPaste(
    tokenizer: { takeDroppedPaste(): { readonly chars: number; readonly limit: number } | undefined },
    conversation: { log(text: string): void } | null,
    requestRender: () => void,
): void {
    const dropped = tokenizer.takeDroppedPaste();
    if (!dropped) return;
    conversation?.log(`Paste of ${dropped.chars.toLocaleString('en-US')} characters was not inserted: it is over the ${dropped.limit.toLocaleString('en-US')}-character limit. Save it to a file and attach that instead (@path in the prompt).`);
    requestRender();
}
export const MARKER_REGEX = /\[(TEXT|IMAGE): [^\]]+\]/g;
export const IMAGE_PREFIXES: {
    prefix: string;
    mediaType: string;
}[] = [
    { prefix: 'iVBORw0KGgo', mediaType: 'image/png' },
    { prefix: '/9j/', mediaType: 'image/jpeg' },
    { prefix: 'UklGR', mediaType: 'image/webp' },
    { prefix: 'R0lGOD', mediaType: 'image/gif' },
];
export const BINARY_IMAGE_MAGIC: {
    magic: number[];
    mediaType: string;
    extraCheck?: ((b: Buffer) => boolean) | undefined;
}[] = [
    { magic: [0x89, 0x50, 0x4E, 0x47], mediaType: 'image/png' },
    { magic: [0xFF, 0xD8, 0xFF], mediaType: 'image/jpeg' },
    { magic: [0x52, 0x49, 0x46, 0x46], mediaType: 'image/webp', extraCheck: (b: Buffer) => b.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
    { magic: [0x47, 0x49, 0x46, 0x38], mediaType: 'image/gif' },
];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export function formatFileSize(bytes: number): string {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
export function mediaTypeFromExt(ext: string): string {
    switch (ext.toLowerCase()) {
        case '.png': return 'image/png';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        default: return 'image/jpeg';
    }
}
export type PasteRegistryState = {
    pasteRegistry: Map<string, string>;
    nextPasteId: number;
    imageRegistry: Map<string, {
        data: string;
        mediaType: string;
    }>;
    nextImageId: number;
};
export type ClipboardPasteKind = 'image' | 'text' | 'none';
export interface ClipboardPasteResult {
    prompt: string;
    cursorPos: number;
    nextImageId: number;
    nextPasteId: number;
    pasted: boolean;
    kind: ClipboardPasteKind;
    /** Lines of pasted text (0 for an image or nothing): what a receipt may say about it. */
    lines: number;
    marker?: string | undefined;
}

/**
 * What a paste may tell a caller other than the composer itself (a tool
 * receipt the model reads): whether something was pasted, its kind and line
 * count. Never the clipboard text, the marker standing for it, or the
 * composer around it.
 */
export function clipboardPasteReceipt(result: Pick<ClipboardPasteResult, 'pasted' | 'kind' | 'lines'>): { readonly pasted: boolean; readonly kind: ClipboardPasteKind; readonly lines: number } {
    return { pasted: result.pasted, kind: result.kind, lines: result.lines };
}
export interface ClipboardPasteSource {
    pasteImageFromClipboard: typeof pasteImageFromClipboard;
    pasteFromClipboard: typeof pasteFromClipboard;
}
export function registerPaste(state: PasteRegistryState, content: string, projectRoot: string): {
    marker: string;
    nextPasteId: number;
    nextImageId: number;
} {
    const bytes = Buffer.from(content, 'binary');
    if (bytes.length > 100) {
        for (const { magic, mediaType, extraCheck } of BINARY_IMAGE_MAGIC) {
            if (magic.every((b, i) => bytes[i] === b) && (!extraCheck || extraCheck(bytes))) {
                const id = `img${state.nextImageId++}`;
                const base64 = bytes.toString('base64');
                const sizeKB = Math.round(bytes.length / 1024);
                state.imageRegistry.set(id, { data: base64, mediaType });
                return { marker: `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
            }
        }
    }
    const trimmed = content.trim();
    if (trimmed.length > 100) {
        for (const { prefix, mediaType } of IMAGE_PREFIXES) {
            if (trimmed.startsWith(prefix)) {
                const id = `img${state.nextImageId++}`;
                const sizeKB = Math.round(trimmed.length * 3 / 4 / 1024);
                state.imageRegistry.set(id, { data: trimmed, mediaType });
                return { marker: `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
            }
        }
    }
    if (IMAGE_EXTENSIONS.some(ext => trimmed.toLowerCase().endsWith(ext))) {
        try {
            const resolvedPath = resolveAndValidatePath(trimmed, projectRoot);
            // An oversize image stays a plain pasted path instead of being read into memory.
            if (existsSync(resolvedPath) && statSync(resolvedPath).size <= MAX_IMAGE_ATTACH_BYTES) {
                const data = readFileSync(resolvedPath);
                const base64 = data.toString('base64');
                const ext = trimmed.slice(trimmed.lastIndexOf('.'));
                const mediaType = mediaTypeFromExt(ext);
                const filename = trimmed.split('/').pop() ?? 'image';
                const id = `img${state.nextImageId++}`;
                state.imageRegistry.set(id, { data: base64, mediaType });
                return { marker: `[IMAGE: ${id}, ${filename}, ${formatFileSize(data.length)}]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
            }
        }
        catch (err) {
            logger.debug('registerPaste: could not read image file path', { err });
        }
    }
    // Terminals transmit the line breaks inside a bracketed paste as \r (the
    // byte Enter sends), and external clipboards can carry \r\n. Normalize to
    // \n only here in the text branch, the image sniffing above must see the
    // raw bytes (PNG's magic sequence itself contains \r\n).
    const text = content.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (lines.length <= 8)
        return { marker: text, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
    const id = `p${state.nextPasteId++}`;
    state.pasteRegistry.set(id, text);
    return { marker: `[TEXT: ${id}, ${lines.length} lines]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
}
/** What a block marker in a sent message stands for: a collapsed paste's text or a pasted image. */
export type ComposerBlock =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'image'; readonly data: string; readonly mediaType: string };
/** A message as the composer held it: its text with block markers, and the block behind each marker, by the marker's id. */
export interface ComposerMessage {
    readonly text: string;
    readonly blocks: ReadonlyMap<string, ComposerBlock>;
}
/** `[TEXT: <id>, <n> lines]`: the id is `pN` in the composer and a content key in input history. */
export const TEXT_BLOCK_MARKER = /\[TEXT: ([^,\]\s]+), (\d+) lines\]/g;
/** `[IMAGE: <id>, <label>]`: the id is `imgN` in the composer and a content key in input history. */
export const IMAGE_BLOCK_MARKER = /\[IMAGE: ([^,\]\s]+), ([^\]]*)\]/g;
/** The blocks behind the markers in `text`, read from the composer's registries. */
export function collectComposerBlocks(text: string, pasteRegistry: ReadonlyMap<string, string>, imageRegistry: ReadonlyMap<string, {
    readonly data: string;
    readonly mediaType: string;
}>): Map<string, ComposerBlock> {
    const blocks = new Map<string, ComposerBlock>();
    for (const match of text.matchAll(TEXT_BLOCK_MARKER)) {
        const id = requireDefined(match[1]);
        const content = pasteRegistry.get(id);
        if (content !== undefined)
            blocks.set(id, { kind: 'text', text: content });
    }
    for (const match of text.matchAll(IMAGE_BLOCK_MARKER)) {
        const id = requireDefined(match[1]);
        const image = imageRegistry.get(id);
        if (image)
            blocks.set(id, { kind: 'image', data: image.data, mediaType: image.mediaType });
    }
    return blocks;
}
/**
 * Puts a recalled message back in the composer as a fresh paste would be:
 * each block gets a new composer id and its content in the registry, and its
 * marker in the returned text names that id. A marker with no block (a line
 * saved before blocks were kept) stays the text it is.
 */
export function restoreComposerBlocks(state: PasteRegistryState, message: ComposerMessage): string {
    if (message.blocks.size === 0)
        return message.text;
    const assigned = new Map<string, string>();
    const liveId = (id: string): string | undefined => {
        const known = assigned.get(id);
        if (known !== undefined)
            return known;
        const block = message.blocks.get(id);
        if (!block)
            return undefined;
        let live: string;
        if (block.kind === 'text') {
            live = `p${state.nextPasteId++}`;
            state.pasteRegistry.set(live, block.text);
        }
        else {
            live = `img${state.nextImageId++}`;
            state.imageRegistry.set(live, { data: block.data, mediaType: block.mediaType });
        }
        assigned.set(id, live);
        return live;
    };
    return message.text
        .replace(TEXT_BLOCK_MARKER, (marker: string, id: string, lines: string) => {
            const live = liveId(id);
            return live === undefined ? marker : `[TEXT: ${live}, ${lines} lines]`;
        })
        .replace(IMAGE_BLOCK_MARKER, (marker: string, id: string, label: string) => {
            const live = liveId(id);
            return live === undefined ? marker : `[IMAGE: ${live}, ${label}]`;
        });
}
export function expandTextPastes(pasteRegistry: Map<string, string>, text: string): string {
    const used = new Set<string>();
    const expanded = text.replace(/\[TEXT: (p\d+), (\d+) lines\]/g, (marker, id: string) => {
        const content = pasteRegistry.get(id);
        if (!content)
            return marker;
        used.add(id);
        return content;
    });
    for (const id of pasteRegistry.keys())
        if (!used.has(id))
            pasteRegistry.delete(id);
    return expanded;
}
export function expandPrompt(pasteRegistry: Map<string, string>, imageRegistry: Map<string, {
    data: string;
    mediaType: string;
}>, text: string, projectRoot: string, contextReferences = false): string | ContentPart[] {
    // Only what the user typed pulls files in: references are expanded before
    // a collapsed paste is spliced in (a `!@path` inside an eight-line-plus
    // paste was never seen or chosen), and an expanded file is not rescanned.
    const failures: PromptReferenceFailure[] = [];
    // A referenced image takes an id no pasted image can hold (`imgrN`), so the
    // registry's own counter, which the host owns, is left alone.
    let referencedImages = 0;
    const attachImage: AttachReferencedImage = (image) => {
        const id = `imgr${++referencedImages}`;
        imageRegistry.set(id, { data: image.data, mediaType: image.mediaType });
        return `[IMAGE: ${id}, ${image.name}, ${formatFileSize(image.bytes)}]`;
    };
    let expanded = expandTypedReferences(text, projectRoot, contextReferences, failures, attachImage);
    if (failures.length > 0) {
        const named = failures.map((failure) => `${failure.reference} (${failure.reason})`).join(', ');
        throw new RefusalError(refusal({
            code: 'PROMPT_REFERENCE_UNREADABLE',
            state: 'the message was not sent and is still in the composer',
            reason: `Not sent: could not read ${named}`,
            next: ['Your message is still in the composer; fix or remove the reference, then press Enter'],
        }));
    }
    expanded = expandTextPastes(pasteRegistry, expanded);
    // The message leaves the composer holding its pasted text, so none stays
    // behind: a history line recalled later that names a `pN` it was saved
    // without (its content was not kept) is not filled from an earlier message.
    pasteRegistry.clear();
    const imageMarkerRegex = /\[IMAGE: (imgr?\d+), [^\]]+\]/g;
    const imageMarkers: {
        marker: string;
        index: number;
        id: string;
    }[] = [];
    let imgMatch;
    while ((imgMatch = imageMarkerRegex.exec(expanded)) !== null) {
        imageMarkers.push({ marker: imgMatch[0], index: imgMatch.index, id: requireDefined(imgMatch[1]) });
    }
    if (imageMarkers.length === 0) {
        imageRegistry.clear();
        return expanded;
    }
    const parts: ContentPart[] = [];
    let lastIndex = 0;
    const usedIds = new Set<string>();
    for (const { marker, index, id } of imageMarkers) {
        if (index > lastIndex) {
            const textSegment = expanded.slice(lastIndex, index);
            if (textSegment)
                parts.push({ type: 'text', text: textSegment });
        }
        const img = imageRegistry.get(id);
        if (img) {
            parts.push({ type: 'image', data: img.data, mediaType: img.mediaType });
            usedIds.add(id);
        }
        lastIndex = index + marker.length;
    }
    if (lastIndex < expanded.length) {
        const textSegment = expanded.slice(lastIndex);
        if (textSegment)
            parts.push({ type: 'text', text: textSegment });
    }
    for (const id of imageRegistry.keys()) {
        if (!usedIds.has(id))
            imageRegistry.delete(id);
    }
    return parts;
}
export function cleanupMarkerRegistry(imageRegistry: Map<string, {
    data: string;
    mediaType: string;
}>, markerText: string): void {
    const match = /^\[IMAGE: (img\d+),/.exec(markerText);
    if (match) {
        imageRegistry.delete(match[1]!);
    }
}
export function findMarkerAtPos(prompt: string, pos: number): {
    start: number;
    end: number;
} | null {
    const markerRegex = new RegExp(MARKER_REGEX.source, 'g');
    let m;
    while ((m = markerRegex.exec(prompt)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (pos > start && pos <= end) {
            return { start, end };
        }
    }
    return null;
}
export function handleClipboardPaste(state: PasteRegistryState & {
    prompt: string;
    cursorPos: number;
    saveUndoState: () => void;
    ensureInputCursorVisible: () => void;
    requestRender: () => void;
}, projectRoot: string, clipboard: ClipboardPasteSource = { pasteImageFromClipboard, pasteFromClipboard }): ClipboardPasteResult {
    const img = clipboard.pasteImageFromClipboard();
    let pasted = false;
    let kind: ClipboardPasteKind = 'none';
    let lines = 0;
    let insertedMarker: string | undefined;
    if (img) {
        state.saveUndoState();
        const id = `img${state.nextImageId++}`;
        const sizeKB = Math.round(img.data.length * 3 / 4 / 1024);
        state.imageRegistry.set(id, img);
        const marker = `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
        state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
        state.cursorPos += marker.length;
        pasted = true;
        kind = 'image';
        insertedMarker = marker;
    }
    else {
        const raw = clipboard.pasteFromClipboard();
        if (raw) {
            state.saveUndoState();
            const { marker } = registerPaste(state, raw, projectRoot);
            state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
            state.cursorPos += marker.length;
            pasted = true;
            kind = marker.startsWith('[IMAGE:') ? 'image' : 'text';
            lines = kind === 'text' ? raw.split(/\r\n|\r|\n/).length : 0;
            insertedMarker = marker;
        }
    }
    state.ensureInputCursorVisible();
    state.requestRender();
    return {
        prompt: state.prompt,
        cursorPos: state.cursorPos,
        nextImageId: state.nextImageId,
        nextPasteId: state.nextPasteId,
        pasted,
        kind,
        lines,
        marker: insertedMarker,
    };
}
export function handleCtrlC(prompt: string, saveUndoState: () => void, setPrompt: (value: string) => void, setCursorPos: (value: number) => void, cancelGeneration: (() => boolean | void) | undefined, exitApp: () => void, requestRender: () => void, lastCtrlCTime: number, setLastCtrlCTime: (value: number) => void, setShowExitNotice: (value: boolean) => void, lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null = null, setLastCtrlCTimeoutId: (value: ReturnType<typeof setTimeout> | null) => void = () => { }): void {
    if (prompt.length > 0) {
        saveUndoState();
        setPrompt('');
        setCursorPos(0);
        return;
    }
    // Stopping in-flight speech / aborting the turn must never prevent the quit
    // double-press window from advancing. A throw from the async TTS-stop path
    // (e.g. killing the audio subprocess) would otherwise swallow this press and
    // strand the user unable to quit while TTS is speaking. Decouple the two: the
    // press below is recorded no matter how speech-stop fares. (item 6b.)
    let stoppedSpeech = false;
    try {
        stoppedSpeech = cancelGeneration?.() === true;
    }
    catch {
        // Non-fatal to the exit chord; the quit-window bookkeeping still runs.
    }
    // A press that silenced LIVE speech is consumed by that job (an earlier replay
    // fix), symmetric with the prompt-clearing press above. The quit chord
    // ("Ctrl+C x2") starts from a quiet state; turn-aborts still count toward
    // the double-press.
    if (stoppedSpeech)
        return;
    const now = Date.now();
    // Clear any hide-timer pending from a prior press before deciding this
    // one's outcome, whichever branch below runs. Without this, a hide-timer
    // scheduled by an earlier press could still fire after a newer notice
    // window opened, or after exitApp() was just called (if exitApp isn't
    // synchronous), flipping showExitNotice/requestRender during a shutdown
    // the user already believes is in progress.
    if (lastCtrlCTimeoutId !== null) {
        clearTimeout(lastCtrlCTimeoutId);
        setLastCtrlCTimeoutId(null);
    }
    if (now - lastCtrlCTime < 1000) {
        exitApp();
        return;
    }
    setLastCtrlCTime(now);
    setShowExitNotice(true);
    requestRender();
    const timeoutId = setTimeout(() => {
        setShowExitNotice(false);
        setLastCtrlCTimeoutId(null);
        requestRender();
    }, 1000);
    setLastCtrlCTimeoutId(timeoutId);
}

export function registerPasteForHost(handler: PasteRegistryState, content: string, projectRoot: string): string {
    const result = registerPaste({
      pasteRegistry: handler.pasteRegistry,
      nextPasteId: handler.nextPasteId,
      imageRegistry: handler.imageRegistry,
      nextImageId: handler.nextImageId,
    }, content, projectRoot);
    handler.nextPasteId = result.nextPasteId;
    handler.nextImageId = result.nextImageId;
    return result.marker;
  }
