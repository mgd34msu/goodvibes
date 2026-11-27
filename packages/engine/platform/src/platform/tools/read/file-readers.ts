import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { extname, isAbsolute, relative } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { logger } from '../../utils/logger.js';
import { isNotebookFile } from '../../utils/notebook.js';
import { FileStateCache } from '../../state/file-cache.js';
import { ProjectIndex } from '../../state/project-index.js';
import { watchIndexedFile } from '../../state/file-watcher.js';
import { CodeIntelligence } from '../../intelligence/facade.js';
import type { ImageMode } from './media.js';
import {
  IMAGE_SIZE_LIMIT,
  IMAGE_MEDIA_TYPES,
  RESIZE_TARGETS,
  isImageFile as isImageFileByExt,
  isArchiveFile,
  getImageMediaType,
  validateMagicBytes,
  getImageMetadata,
  isBinaryByContent,
  humanSize,
  resizeImage,
  tryLoadSharp,
  convertToPortableFormat,
  listArchiveContents,
} from './media.js';
import type { ReadFileInput, ExtractMode, OutputFormat } from './schema.js';
import { formatContent, extractOutline, extractSymbols, extractAst } from './text.js';
import { summarizeError } from '../../utils/error-display.js';
import { observeReadContent, type ReadObservation } from './observation.js';

export interface FileReadResult {
  path: string;
  resolvedPath: string;
  content?: string | undefined;
  readObservation?: ReadObservation | undefined;
  lineCount: number;
  byteSize: number;
  tokenEstimate: number;
  extract: ExtractMode;
  binary?: boolean | undefined;
  /** Why a file's content was not returned (for example a binary skip). */
  skipped?: string | undefined;
  /** What makes the returned content differ from the file's bytes (a lossy decode under force_text). */
  warning?: string | undefined;
  image?: boolean | undefined;
  mediaType?: string | undefined;
  error?: string | undefined;
  cache?: { status: 'miss' | 'unchanged' | 'modified' } | undefined;
  metadata?: {
    encoding: string;
    sizeBytes: number;
    cacheStatus: string;
  };
  imageData?: { base64: string; mediaType: string };
  imageMetadata?: {
    width?: number | undefined;
    height?: number | undefined;
    format: string;
    fileSize: number;
    resized?: boolean | undefined;
    converted?: boolean | undefined;
    originalFormat?: string | undefined;
    mode?: ImageMode | undefined;
  };
  archive?: boolean | undefined;
}

/** An image a read returned, for the turn to attach as an image part; never part of the result text. */
export interface ReadImage { readonly path: string; readonly base64: string; readonly mediaType: string; readonly description: string }

export interface ReadOutput {
  success: boolean;
  error?: string | undefined;
  /** Standard format omits the per-file tokenEstimate and resolvedPath (host facts); verbose keeps them. */
  files?: Array<Omit<FileReadResult, 'tokenEstimate' | 'resolvedPath'> & { tokenEstimate?: number | undefined; resolvedPath?: string | undefined }> | undefined;
  summary: {
    files_read: number;
    files_binary: number;
    files_errored: number;
    total_lines: number;
    /** Whole-file token estimate of the files read, not of what was returned. */
    total_tokens: number;
    /** Same value as total_tokens, under a name that says what it measures. */
    source_tokens?: number | undefined;
    /** Estimated tokens of the content actually returned. */
    returned_tokens?: number | undefined;
    /**
     * Files whose returned content stops before the requested end. A content or lines extract gives
     * returned_lines and next_start_line to continue from; any other clipped result gives returned_characters.
     */
    truncated?: Array<{
      path: string;
      returned_lines?: number | undefined;
      next_start_line?: number | undefined;
      returned_characters?: number | undefined;
      reason: 'max_tokens' | 'max_per_item';
    }> | undefined;
    /** Wall time of a slow call. */
    elapsed_ms?: number | undefined;
  };
  pagination?: {
    page: number;
    total_pages: number;
    pending_files: string[];
  };
}

/**
 * Every reader loads the whole file into memory, so a file past this size is
 * refused up front rather than exhausting the process. The loads are
 * asynchronous: reads of one call, and of calls running side by side, overlap
 * their waits on the disk instead of queueing behind each other.
 */
export const MAX_READ_FILE_BYTES = 128 * 1024 * 1024;

/** Refuses invalid UTF-8 instead of replacing it; a leading BOM is kept, as Buffer.toString keeps it. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function oversizeReadError(target: ReadTarget): Promise<FileReadResult | undefined> {
  let size: number;
  try {
    size = (await stat(target.resolvedPath)).size;
  } catch {
    return undefined; // The reader reports the real failure (missing file, directory, permissions).
  }
  if (size <= MAX_READ_FILE_BYTES) return undefined;
  return createReadErrorResult(
    target,
    `File is ${humanSize(size)}, over the ${humanSize(MAX_READ_FILE_BYTES)} read limit, so it was not read. Search it with find (content mode), or read part of it with exec (for example head, tail or sed -n).`,
    size,
  );
}

function isPdfFile(ext: string): boolean {
  return ext.toLowerCase() === '.pdf';
}

/** Text shown by a PDF's content streams, in file order. Page boundaries are not recoverable without a PDF parser. */
function extractPdfText(body: string, pages?: string): string {
  const texts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(body)) !== null) {
    let chunk = m[1]!;
    // Most content streams are Flate-compressed; the text operators are only visible once inflated.
    try {
      chunk = inflateSync(Buffer.from(chunk, 'binary'), { maxOutputLength: 16 * 1024 * 1024 }).toString('binary');
    } catch {
      // Not compressed (or not Flate): scan the bytes as they are.
    }
    const parenRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = parenRe.exec(chunk)) !== null) {
      const text = pm[1]!
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .trim();
      if (text.length > 1) texts.push(text);
    }
  }

  const pagesNote = pages ? ` The pages argument (${pages}) was not applied: page boundaries are not available, so this is the document's text as a whole.` : '';
  if (texts.length === 0) {
    return JSON.stringify({
      approximate: true,
      note: `PDF text extraction requires a dedicated library for complex PDFs. No readable text streams found.${pagesNote}`,
      byteSize: Buffer.byteLength(body, 'binary'),
      pages: pages ?? 'all',
    });
  }

  return `[approximate PDF text: strings found in the file's content streams, not a layout-aware extraction.${pagesNote}]\n${texts.join(' ')}`;
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: Array<{ output_type: string; text?: string | string[]; data?: Record<string, string | string[]> }> | undefined;
}

interface NotebookJSON {
  cells: NotebookCell[];
}

function formatNotebook(raw: string): string {
  let nb: NotebookJSON;
  try {
    nb = JSON.parse(raw) as NotebookJSON;
  } catch {
    return `[error: invalid notebook JSON]`;
  }

  if (!Array.isArray(nb.cells)) {
    return '[error: notebook has no cells array]';
  }

  const parts: string[] = [];
  nb.cells.forEach((cell, idx) => {
    const cellType = cell.cell_type ?? 'unknown';
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
    parts.push(`[cell ${idx + 1}] (${cellType}):`);
    parts.push(source);

    if (cellType === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const outputLines: string[] = [];
      for (const out of cell.outputs) {
        const textData = out.data?.['text/plain'] ?? out.data?.['text/html'] ?? out.text;
        if (textData) {
          const text = Array.isArray(textData) ? textData.join('') : String(textData);
          outputLines.push(text.trimEnd());
        }
      }
      if (outputLines.length > 0) {
        parts.push('[output]:');
        parts.push(outputLines.join('\n'));
      }
    }
  });

  return parts.join('\n');
}

export interface ReadExecutionContext {
  readonly assertCurrent?: (() => void) | undefined;
  format: OutputFormat;
  includeLineNumbers: boolean;
  maxPerItem?: number | undefined;
  fileCache: FileStateCache;
  projectIndex: ProjectIndex;
  globalImageMode?: ImageMode | undefined;
  maxImageSize: number;
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'> | undefined;
  /** Image-library loader; tests inject one, production uses the lazy sharp import. */
  loadSharp?: typeof tryLoadSharp | undefined;
}

export interface ReadTarget {
  fileInput: ReadFileInput;
  resolvedPath: string;
  extract: ExtractMode;
}

function createReadBaseResult(target: ReadTarget, byteSize: number, tokenEstimate: number): FileReadResult {
  return {
    path: target.fileInput.path,
    resolvedPath: target.resolvedPath,
    lineCount: 0,
    byteSize,
    tokenEstimate,
    extract: target.extract,
  };
}

function createReadErrorResult(target: ReadTarget, message: string, byteSize = 0): FileReadResult {
  return {
    ...createReadBaseResult(target, byteSize, 0),
    error: message,
  };
}

function shouldIncludeContent(format: OutputFormat): boolean {
  return format !== 'count_only' && format !== 'minimal';
}

function getImageMode(fileInput: ReadFileInput, context: ReadExecutionContext): ImageMode {
  return fileInput.image_mode ?? context.globalImageMode ?? 'default';
}

async function readImageFile(
  target: ReadTarget,
  context: ReadExecutionContext,
  imageMode: ImageMode,
  maxImageSize: number,
): Promise<FileReadResult> {
  let imgBuffer: Buffer;
  try {
    context.assertCurrent?.();
    imgBuffer = await readFile(target.resolvedPath);
  } catch (err) {
    const message = summarizeError(err);
    return createReadErrorResult(target, `Cannot read image: ${message}`);
  }

  const byteSize = imgBuffer.length;
  if (byteSize > maxImageSize) {
    const meta = getImageMetadata(imgBuffer, extname(target.resolvedPath));
    return {
      ...createReadBaseResult(target, byteSize, 0),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      content: `Image exceeds size limit (${byteSize} bytes > ${maxImageSize} bytes). Use max_image_size to increase.`,
      imageMetadata: { ...meta, mode: imageMode },
    };
  }

  const magicResult = validateMagicBytes(imgBuffer, extname(target.resolvedPath));
  // The bytes decide what the provider will decode, not the file name. A real image of another
  // type is sent under its true media type; anything else (a Git LFS pointer, text) is refused
  // because a bad image block stays in the conversation and every later turn fails on it.
  let detectedMediaType: string | undefined;
  if (!magicResult.valid && extname(target.resolvedPath).toLowerCase() !== '.svg') {
    detectedMediaType = magicResult.detectedType ? IMAGE_MEDIA_TYPES[`.${magicResult.detectedType}`] : undefined;
    if (!detectedMediaType) {
      logger.warn('[read] image magic bytes mismatch', {
        path: target.resolvedPath,
        expected: extname(target.resolvedPath),
        detected: magicResult.detectedType ?? 'unknown',
      });
      return createReadErrorResult(
        target,
        `${extname(target.resolvedPath)} file is not an image${magicResult.detectedType ? ` (its bytes look like ${magicResult.detectedType})` : ' (its bytes do not match any image format)'}. Read it with extract:'content' and force_text:true if it is text.`,
        byteSize,
      );
    }
  }

  const rawMeta = getImageMetadata(imgBuffer, extname(target.resolvedPath));
  if (!shouldIncludeContent(context.format)) {
    indexReadFile(context, target.resolvedPath, Math.ceil(byteSize / 4));
    return {
      ...createReadBaseResult(target, byteSize, Math.ceil(byteSize / 4)),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      imageMetadata: { ...rawMeta, mode: imageMode },
    };
  }

  if (imageMode === 'metadata-only') {
    indexReadFile(context, target.resolvedPath, Math.ceil(byteSize / 4));
    return {
      ...createReadBaseResult(target, byteSize, 0),
      image: true,
      mediaType: getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream',
      content: `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}`,
      imageMetadata: { ...rawMeta, mode: imageMode },
    };
  }

  let processedBuffer = imgBuffer;
  let mediaType = detectedMediaType ?? getImageMediaType(extname(target.resolvedPath)) ?? 'application/octet-stream';
  let resized = false;
  let converted = false;
  let originalFormat: string | undefined;

  const convertResult = await convertToPortableFormat(imgBuffer, extname(target.resolvedPath));
  context.assertCurrent?.();
  if (convertResult.converted) {
    processedBuffer = convertResult.buffer;
    mediaType = convertResult.mediaType;
    converted = true;
    originalFormat = convertResult.originalFormat;
  }

  const resizeTarget = RESIZE_TARGETS[imageMode]!;
  if (resizeTarget !== null) {
    const resizeResult = await resizeImage(processedBuffer, mediaType, resizeTarget, context.loadSharp);
    context.assertCurrent?.();
    if (resizeResult.resized) {
      processedBuffer = resizeResult.buffer;
      resized = true;
      // Resizing re-encodes (PNG, or JPEG for JPEG input), whatever the file extension said.
      if (resizeResult.mediaType) mediaType = resizeResult.mediaType;
      if (resizeResult.width) rawMeta.width = resizeResult.width;
      if (resizeResult.height) rawMeta.height = resizeResult.height;
    }
  }

  const b64 = processedBuffer.toString('base64');
  const tokenEst = Math.ceil(processedBuffer.length / 4);
  indexReadFile(context, target.resolvedPath, tokenEst);

  const desc = `Image: ${rawMeta.width ?? '?'}x${rawMeta.height ?? '?'} ${rawMeta.format}, ${humanSize(byteSize)}${resized ? ' (resized)' : ''}${converted ? ` (converted from ${originalFormat})` : ''}`;
  return {
    ...createReadBaseResult(target, byteSize, tokenEst),
    content: desc,
    image: true,
    mediaType,
    imageData: { base64: b64, mediaType },
    imageMetadata: { ...rawMeta, resized, converted, originalFormat, mode: imageMode },
  };
}

async function readArchiveFile(target: ReadTarget, context: ReadExecutionContext): Promise<FileReadResult> {
  let archiveBuffer: Buffer;
  try {
    context.assertCurrent?.();
    archiveBuffer = await readFile(target.resolvedPath);
  } catch (err) {
    const message = summarizeError(err);
    return createReadErrorResult(target, `Cannot read archive: ${message}`);
  }

  let listing: string;
  try {
    listing = listArchiveContents(target.resolvedPath, archiveBuffer, extname(target.resolvedPath));
  } catch (err) {
    return createReadErrorResult(target, `Cannot list archive: ${summarizeError(err)}`, archiveBuffer.length);
  }
  const tokenEst = Math.ceil(listing.length / 4);
  indexReadFile(context, target.resolvedPath, tokenEst);
  return { ...createReadBaseResult(target, archiveBuffer.length, tokenEst), content: listing, lineCount: listing.split('\n').length, archive: true };
}

async function readPdfFile(target: ReadTarget, context: ReadExecutionContext, fileInput: ReadFileInput): Promise<FileReadResult> {
  let pdfRaw: string;
  let pdfByteSize = 0;
  try {
    context.assertCurrent?.();
    const buf = await readFile(target.resolvedPath);
    pdfByteSize = buf.length;
    pdfRaw = buf.toString('binary');
  } catch (err) {
    const message = summarizeError(err);
    return createReadErrorResult(target, `Cannot read PDF: ${message}`);
  }

  const pdfText = extractPdfText(pdfRaw, fileInput.pages);
  const tokenEst = Math.ceil(pdfByteSize / 4);
  indexReadFile(context, target.resolvedPath, tokenEst);
  const pdfLines = pdfText.split('\n');
  return { ...createReadBaseResult(target, pdfByteSize, tokenEst), content: shouldIncludeContent(context.format) ? pdfText : undefined, lineCount: pdfLines.length };
}

async function readNotebookFile(target: ReadTarget, context: ReadExecutionContext): Promise<FileReadResult> {
  let nbRaw: string;
  let nbByteSize = 0;
  try {
    context.assertCurrent?.();
    nbRaw = await readFile(target.resolvedPath, 'utf-8');
    nbByteSize = Buffer.byteLength(nbRaw, 'utf-8');
  } catch (err) {
    const message = summarizeError(err);
    return createReadErrorResult(target, `Cannot read notebook: ${message}`);
  }

  // What this reader has seen: a later edit or write of the notebook compares against it.
  context.fileCache.update(target.resolvedPath, nbRaw, { tool: 'read' });
  const formatted = formatNotebook(nbRaw);
  const tokenEst = Math.ceil(nbByteSize / 4);
  indexReadFile(context, target.resolvedPath, tokenEst);
  const nbLines = formatted.split('\n');
  return { ...createReadBaseResult(target, nbByteSize, tokenEst), content: shouldIncludeContent(context.format) ? formatted : undefined, lineCount: nbLines.length };
}

async function readTextFile(target: ReadTarget, context: ReadExecutionContext, fileInput: ReadFileInput): Promise<FileReadResult> {
  let fullBuf: Buffer;
  try {
    context.assertCurrent?.();
    fullBuf = await readFile(target.resolvedPath);
  } catch (err) {
    const message = summarizeError(err);
    logger.warn('read tool: file read failed', { path: target.resolvedPath, error: message });
    return createReadErrorResult(target, `Cannot read file: ${message}`);
  }

  if (!fileInput.force_text && isBinaryByContent(fullBuf)) {
    logger.debug('read tool: binary file skipped', { path: target.resolvedPath });
    return { ...createReadBaseResult(target, fullBuf.length, 0), binary: true,
      skipped: `contains a NUL byte at offset ${fullBuf.indexOf(0)}; pass force_text: true for this file to read it as text anyway` };
  }

  let rawContent: string;
  let encodingWarning: string | undefined;
  try {
    rawContent = STRICT_UTF8.decode(fullBuf);
  } catch (err) {
    if (!fileInput.force_text) {
      logger.debug('read tool: file is not valid UTF-8', { path: target.resolvedPath, error: summarizeError(err) });
      return createReadErrorResult(target, 'File is not valid UTF-8 text (it may use another encoding such as Latin-1 or Shift-JIS), so it was not read. Pass force_text: true for this file to read it with each invalid byte shown as the replacement character U+FFFD; edits built on that text would rewrite those bytes.', fullBuf.length);
    }
    rawContent = fullBuf.toString('utf-8');
    encodingWarning = 'This file is not valid UTF-8; each invalid byte is shown as the replacement character U+FFFD, so this is not the exact file text and an edit built on it would rewrite those bytes.';
  }

  // Compared with the bytes this call just read: one read, one instant.
  const cacheResult = { status: fileInput.force ? 'miss' as const : context.fileCache.compare(target.resolvedPath, rawContent) };
  context.fileCache.update(target.resolvedPath, rawContent, { tool: 'read' });

  const byteSize = Buffer.byteLength(rawContent, 'utf-8');
  const tokenEstimate = Math.ceil(byteSize / 4);
  indexReadFile(context, target.resolvedPath, tokenEstimate);

  // A CRLF file's rows carry no trailing \r: the row text is the line, and
  // recorded reads of it compare equal to the file's lines.
  const lines = rawContent.split(/\r?\n/);
  // The element after a final newline is not a line.
  const lineCount = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  const range = fileInput.range;
  if (range && (target.extract === 'content' || target.extract === 'lines') && (range.end < range.start || range.start > lineCount)) {
    return {
      ...createReadBaseResult(target, byteSize, 0),
      lineCount,
      error: `Requested lines ${range.start}-${range.end} are outside this file, which has ${lineCount} line${lineCount === 1 ? '' : 's'}.`,
    };
  }

  let extractedContent: string | undefined;
  if (shouldIncludeContent(context.format)) {
    switch (target.extract) {
      case 'content':
      case 'lines':
        extractedContent = formatContent(lines, context.includeLineNumbers, fileInput.range, context.maxPerItem);
        break;
      case 'outline':
        extractedContent = await extractOutline(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      case 'symbols':
        extractedContent = await extractSymbols(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      case 'ast':
        extractedContent = await extractAst(target.resolvedPath, rawContent, lines, context.includeLineNumbers, context.codeIntelligence);
        break;
      default:
        extractedContent = formatContent(lines, context.includeLineNumbers, fileInput.range, context.maxPerItem);
    }
  }

  context.assertCurrent?.();
  const result: FileReadResult = {
    ...createReadBaseResult(target, byteSize, tokenEstimate),
    content: extractedContent,
    lineCount,
    cache: { status: cacheResult.status },
    ...(encodingWarning !== undefined ? { warning: encodingWarning } : {}),
  };
  if (extractedContent !== undefined && (target.extract === 'content' || target.extract === 'lines')) {
    const startLine = fileInput.range?.start ?? 1;
    const available = Math.max(0, Math.min(lineCount, fileInput.range?.end ?? lineCount) - startLine + 1);
    const completeLines = Math.min(available, context.maxPerItem === undefined ? available : Math.max(0, Math.trunc(context.maxPerItem)));
    result.readObservation = observeReadContent(extractedContent, startLine, completeLines, context.includeLineNumbers);
  }

  if (context.format === 'verbose') {
    result.metadata = { encoding: 'utf-8', sizeBytes: byteSize, cacheStatus: cacheResult.status };
  }

  return result;
}

function indexReadFile(context: ReadExecutionContext, path: string, tokens: number): void {
  const local = relative(context.projectIndex.baseDir, path);
  if (local !== '..' && !local.startsWith('../') && !isAbsolute(local)) {
    context.projectIndex.upsertFile(path, tokens);
    watchIndexedFile(context.projectIndex, path);
  }
}

export async function readOneFile(
  fileInput: ReadFileInput,
  globalExtract: ExtractMode,
  format: OutputFormat,
  includeLineNumbers: boolean,
  maxPerItem: number | undefined,
  fileCache: FileStateCache,
  projectIndex: ProjectIndex,
  globalImageMode?: ImageMode,
  globalMaxImageSize?: number,
  codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
  assertCurrent?: () => void,
  allowOutsideProject = false,
  loadSharp?: typeof tryLoadSharp,
): Promise<FileReadResult> {
  assertCurrent?.();
  const extract: ExtractMode = fileInput.extract ?? globalExtract;

  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidatePath(fileInput.path, projectIndex.baseDir, allowOutsideProject);
  } catch (err) {
    const message = summarizeError(err);
    logger.warn('read tool: path validation failed', { path: fileInput.path, error: message });
    return createReadErrorResult({ fileInput, resolvedPath: fileInput.path, extract }, message);
  }

  const target: ReadTarget = { fileInput, resolvedPath, extract };
  const oversize = await oversizeReadError(target);
  if (oversize) return oversize;
  const context: ReadExecutionContext = {
    format,
    includeLineNumbers,
    maxPerItem,
    fileCache,
    projectIndex,
    globalImageMode,
    maxImageSize: globalMaxImageSize ?? IMAGE_SIZE_LIMIT,
    codeIntelligence,
    assertCurrent,
    loadSharp,
  };

  const ext = extname(resolvedPath);
  const imageMode = getImageMode(fileInput, context);

  // SVG is also authored text. An explicit line extraction must expose its
  // source and actual returned ranges, rather than silently returning artwork.
  if (ext.toLowerCase() === '.svg' && extract === 'lines') return readTextFile(target, context, fileInput);
  if (isImageFileByExt(ext)) return readImageFile(target, context, imageMode, context.maxImageSize);
  if (isArchiveFile(ext)) return readArchiveFile(target, context);
  if (isPdfFile(ext)) return readPdfFile(target, context, fileInput);
  if (isNotebookFile(resolvedPath)) return readNotebookFile(target, context);
  return readTextFile(target, context, fileInput);
}

export function paginateFiles(files: ReadFileInput[], tokenBudget: number, projectRoot: string, allowOutsideProject = false): Array<number[]> {
  const pages: Array<number[]> = [];
  let currentPage: number[] = [];
  let currentTokens = 0;

  for (let i = 0; i < files.length; i++) {
    let est = 0;
    try {
      const resolved = resolveAndValidatePath((files[i]?.path ?? ''), projectRoot, allowOutsideProject);
      est = Math.ceil(statSync(resolved).size / 4);
    } catch {
      est = 0;
    }

    if (est > tokenBudget && currentPage.length === 0) {
      pages.push([i]);
      currentPage = [];
      currentTokens = 0;
      continue;
    }

    if (currentTokens + est > tokenBudget && currentPage.length > 0) {
      pages.push(currentPage);
      currentPage = [i];
      currentTokens = est;
    } else {
      currentPage.push(i);
      currentTokens += est;
    }
  }
  if (currentPage.length > 0) pages.push(currentPage);
  return pages;
}
