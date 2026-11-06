import { existsSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { basename, relative } from 'node:path';
import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import { logger, summarizeError, resolveAndValidatePath, requireDefined } from '@goodvibes-jev/engine/sdk/platform/utils';
import { pasteImageFromClipboard, pasteFromClipboard } from './clipboard.js';
const URL_REFERENCE_REGEX = /^https?:\/\/[^\s]+$/i;
const CONTEXT_REFERENCE_REGEX = /(^|\s)@([^\s]+)/g;
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
function readContextFileBlock(reference: string, projectRoot: string): string | null {
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
    const stat = lstatSync(resolvedPath);
    const label = escapeContextAttribute(relative(projectRoot, resolvedPath) || basename(resolvedPath));
    if (stat.isDirectory()) {
        const entries = readdirSync(resolvedPath, { withFileTypes: true })
            .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
            .join('\n');
        return [
            `<context-folder path="${label}">`,
            entries || '(empty directory)',
            stat.isDirectory() ? `</context-folder>` : '',
        ].filter(Boolean).join('\n');
    }
    if (!stat.isFile())
        return null;
    return [
        `<context-file path="${label}" bytes="${stat.size}">`,
        readFileSync(resolvedPath, 'utf-8'),
        '</context-file>',
    ].join('\n');
}
function buildContextUrlBlock(reference: string): string {
    const href = escapeContextAttribute(reference);
    return [
        `<context-url href="${href}">`,
        'The user referenced this URL in the prompt. Use connected tools only if content retrieval is needed; do not ingest it into Agent Knowledge unless the user explicitly asks.',
        '</context-url>',
    ].join('\n');
}
function expandContextReferences(text: string, projectRoot: string): string {
    return text.replace(CONTEXT_REFERENCE_REGEX, (full: string, prefix: string, rawReference: string): string => {
        if (rawReference.startsWith('model:'))
            return full;
        const { core, suffix } = stripTrailingReferencePunctuation(rawReference);
        if (!core || core.startsWith('@'))
            return full;
        if (URL_REFERENCE_REGEX.test(core)) {
            return `${prefix}${buildContextUrlBlock(core)}${suffix}`;
        }
        const fileBlock = readContextFileBlock(core, projectRoot);
        if (!fileBlock)
            return full;
        return `${prefix}${fileBlock}${suffix}`;
    });
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
    { magic: [0x47, 0x49, 0x46], mediaType: 'image/gif' },
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
    marker?: string | undefined;
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
            if (existsSync(resolvedPath)) {
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
    let expanded = expandTextPastes(pasteRegistry, text);
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    let injectMatch;
    while ((injectMatch = injectRegex.exec(expanded)) !== null) {
        const filePath = injectMatch[1];
        try {
            const resolvedPath = resolveAndValidatePath(requireDefined(filePath), projectRoot);
            const content = readFileSync(resolvedPath, 'utf-8');
            expanded = expanded.slice(0, injectMatch.index) + content + expanded.slice(injectMatch.index + injectMatch[0].length);
            injectRegex.lastIndex = injectMatch.index + content.length;
        }
        catch (err) {
            logger.debug('expandPrompt: failed to read injected file', { path: filePath, error: summarizeError(err) });
        }
    }
    if (contextReferences)
        expanded = expandContextReferences(expanded, projectRoot);
    const imageMarkerRegex = /\[IMAGE: (img\d+), [^\]]+\]/g;
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
