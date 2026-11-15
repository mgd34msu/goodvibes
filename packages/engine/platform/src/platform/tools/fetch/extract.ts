import type { FetchExtractMode } from './schema.js';
import { readReadable, readSummary } from './page-reading.js';
import { markupText, scanMarkup, tagAttributes } from './markup.js';
import { readMultimodalPdf } from '../../multimodal/pdf-source.js';

/*
 * Every HTML mode below reads the page through the one linear scanner
 * (markup.ts), so the cost of an extract follows the page size whatever the
 * page holds; none of them runs a backtracking pattern over the body.
 */

const HTML_SELECTOR_TAG_RE = /^[a-z][a-z0-9-]*$/i;
const HTML_SELECTOR_ATTRIBUTE_RE = /^[a-z0-9_-]+$/i;

/** Elements whose content is not text a reader of the page sees. */
const NOT_TEXT: ReadonlySet<string> = new Set(['head', 'noscript', 'template', 'svg']);

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, so that "&amp;lt;" decodes once to "&lt;" and not twice to "<".
    .replace(/&amp;/g, '&');
}

function stripHtml(html: string): string {
  return decodeBasicEntities(markupText(html, ' ')).replace(/\s{2,}/g, ' ').trim();
}

function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const links: (string | null)[] = [];
  let inPre = 0;
  for (const token of scanMarkup(html, { skip: NOT_TEXT })) {
    if (token.kind === 'text') {
      out.push(html.slice(token.start, token.end));
      continue;
    }
    if (token.kind === 'element') {
      if (token.name === 'title' || token.name === 'textarea') out.push(html.slice(token.contentStart, token.contentEnd));
      continue;
    }
    if (token.kind !== 'tag') continue;
    const { name, closing } = token;
    const heading = /^h([1-6])$/.exec(name);
    if (heading) { out.push(closing ? '\n' : `${'#'.repeat(Number(heading[1]))} `); continue; }
    switch (name) {
      case 'strong': case 'b': out.push('**'); break;
      case 'em': case 'i': out.push('_'); break;
      case 'a': {
        if (!closing) {
          const href = tagAttributes(token.attributes).get('href');
          links.push(href ?? null);
          if (href !== undefined) out.push('[');
        } else {
          const href = links.pop();
          if (href !== undefined && href !== null) out.push(`](${href})`);
        }
        break;
      }
      case 'img': {
        if (closing) break;
        const attributes = tagAttributes(token.attributes);
        out.push(`![${attributes.get('alt') ?? ''}](${attributes.get('src') ?? ''})`);
        break;
      }
      case 'li': if (!closing) out.push('\n- '); break;
      case 'ul': case 'ol': case 'p': case 'br': out.push('\n'); break;
      case 'hr': out.push('\n---\n'); break;
      case 'pre':
        inPre = closing ? Math.max(0, inPre - 1) : inPre + 1;
        out.push(closing ? '\n```\n' : '```\n');
        break;
      case 'code': if (inPre === 0) out.push('`'); break;
      default: break;
    }
  }
  return decodeBasicEntities(out.join('')).replace(/\n{3,}/g, '\n\n').trim();
}

/** Text of `pre` elements, then of `code` elements outside them, in document order within each kind. */
function extractCodeBlocks(html: string): string {
  const pre: string[] = [];
  const code: string[] = [];
  let preDepth = 0;
  let codeDepth = 0;
  let preText = '';
  let codeText = '';
  for (const token of scanMarkup(html, { skip: NOT_TEXT })) {
    if (token.kind === 'text') {
      const text = html.slice(token.start, token.end);
      if (preDepth > 0) preText += text;
      else if (codeDepth > 0) codeText += text;
      continue;
    }
    if (token.kind !== 'tag') continue;
    if (token.name === 'pre') {
      if (!token.closing) { if (preDepth++ === 0) preText = ''; }
      else if (preDepth > 0 && --preDepth === 0) pre.push(decodeBasicEntities(preText).replace(/\s{2,}/g, ' ').trim());
    } else if (token.name === 'code' && preDepth === 0) {
      if (!token.closing) { if (codeDepth++ === 0) codeText = ''; }
      else if (codeDepth > 0 && --codeDepth === 0) {
        const text = decodeBasicEntities(codeText).replace(/\s{2,}/g, ' ').trim();
        if (text) code.push(text);
      }
    } else if (preDepth > 0) preText += ' ';
    else if (codeDepth > 0) codeText += ' ';
  }
  return [...pre, ...code].join('\n\n');
}

function extractLinks(html: string): string {
  const links: string[] = [];
  for (const token of scanMarkup(html)) {
    if (token.kind !== 'tag' || token.closing) continue;
    const attributes = tagAttributes(token.attributes);
    for (const name of ['href', 'src']) {
      const value = attributes.get(name);
      if (value && !value.startsWith('#')) links.push(value);
    }
  }
  return links.join('\n');
}

interface ParsedSelector { readonly tag: string | null; readonly id: string | null; readonly classes: readonly string[] }

function parseSelectors(selectors: readonly string[]): ParsedSelector[] {
  const parsed: ParsedSelector[] = [];
  const unsupported: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    let tag: string | null = null;
    let id: string | null = null;
    let classes: string[] = [];
    if (trimmed.startsWith('#')) {
      id = trimmed.slice(1);
    } else {
      const [head, ...rest] = trimmed.split('.');
      if (head) tag = head.toLowerCase();
      classes = rest;
      if (trimmed.includes('.') && rest.length === 0) { unsupported.push(selector); continue; }
    }
    if (tag !== null && !HTML_SELECTOR_TAG_RE.test(tag)) { unsupported.push(selector); continue; }
    if (id !== null && !HTML_SELECTOR_ATTRIBUTE_RE.test(id)) { unsupported.push(selector); continue; }
    if (classes.some((cls) => !HTML_SELECTOR_ATTRIBUTE_RE.test(cls))) { unsupported.push(selector); continue; }
    parsed.push({ tag, id, classes });
  }
  // An empty list must mean "no element matched", never "the selector was not understood".
  if (unsupported.length > 0) {
    throw new Error(`Unsupported selector${unsupported.length === 1 ? '' : 's'} for structured extraction: ${unsupported.map((item) => JSON.stringify(item)).join(', ')}. Supported: tag, #id, .class, tag.class (several classes allowed, e.g. div.card.big). Nothing was extracted.`);
  }
  return parsed;
}

function selectorMatches(selector: ParsedSelector, tag: string, attributes: Map<string, string>): boolean {
  if (selector.tag !== null && selector.tag !== tag) return false;
  if (selector.id !== null && attributes.get('id') !== selector.id) return false;
  if (selector.classes.length > 0) {
    const classes = new Set((attributes.get('class') ?? '').split(/\s+/).filter(Boolean));
    if (!selector.classes.every((cls) => classes.has(cls))) return false;
  }
  return true;
}

function extractStructured(html: string, selectors: readonly string[]): string {
  const parsed = parseSelectors(selectors);
  const results: string[][] = parsed.map(() => []);
  const open: { selector: number; tag: string; depth: number; parts: string[] }[] = [];
  for (const token of scanMarkup(html, { skip: NOT_TEXT })) {
    if (token.kind === 'text') {
      const text = html.slice(token.start, token.end);
      for (const capture of open) capture.parts.push(text);
      continue;
    }
    if (token.kind !== 'tag') continue;
    for (const capture of open) capture.parts.push(' ');
    if (token.closing) {
      for (let index = open.length - 1; index >= 0; index--) {
        const capture = open[index]!;
        if (capture.tag !== token.name || --capture.depth > 0) continue;
        open.splice(index, 1);
        const text = decodeBasicEntities(capture.parts.join('')).replace(/\s{2,}/g, ' ').trim();
        if (text) results[capture.selector]!.push(text);
      }
      continue;
    }
    for (const capture of open) if (capture.tag === token.name && !token.selfClosing) capture.depth++;
    if (token.selfClosing) continue;
    const attributes = tagAttributes(token.attributes);
    parsed.forEach((selector, index) => {
      if (selectorMatches(selector, token.name, attributes)) open.push({ selector: index, tag: token.name, depth: 1, parts: [] });
    });
  }
  // An element the page never closes runs to the end of the page.
  for (const capture of open) {
    const text = decodeBasicEntities(capture.parts.join('')).replace(/\s{2,}/g, ' ').trim();
    if (text) results[capture.selector]!.push(text);
  }
  return JSON.stringify(results.flat());
}

function extractTables(html: string): string {
  const tables: { headers: string[]; rows: string[][] }[] = [];
  const stack: { headers: string[]; rows: string[][]; row: string[] | null; rowHasHeader: boolean; cell: { header: boolean; parts: string[] } | null }[] = [];
  for (const token of scanMarkup(html, { skip: NOT_TEXT })) {
    const table = stack[stack.length - 1];
    if (token.kind === 'text') {
      table?.cell?.parts.push(html.slice(token.start, token.end));
      continue;
    }
    if (token.kind !== 'tag') continue;
    const { name, closing } = token;
    if (name === 'table') {
      if (!closing) {
        const created = { headers: [] as string[], rows: [] as string[][], row: null, rowHasHeader: false, cell: null };
        tables.push(created);
        stack.push(created);
      } else stack.pop();
      continue;
    }
    if (!table) continue;
    const endCell = (): void => {
      if (!table.cell) return;
      const text = decodeBasicEntities(table.cell.parts.join('')).replace(/\s{2,}/g, ' ').trim();
      if (table.cell.header) { table.headers.push(text); table.rowHasHeader = true; } else table.row?.push(text);
      table.cell = null;
    };
    const endRow = (): void => {
      endCell();
      if (table.row && table.row.length > 0 && !table.rowHasHeader) table.rows.push(table.row);
      table.row = null;
      table.rowHasHeader = false;
    };
    if (name === 'tr') {
      endRow();
      if (!closing) table.row = [];
    } else if (name === 'td' || name === 'th') {
      endCell();
      if (!closing) {
        table.row ??= [];
        table.cell = { header: name === 'th', parts: [] };
      }
    } else table.cell?.parts.push(' ');
  }
  return JSON.stringify(tables.map(({ headers, rows }) => ({ headers, rows })));
}

function extractMetadata(html: string): string {
  const result: Record<string, string> = {};
  for (const token of scanMarkup(html)) {
    if (token.kind === 'element' && token.name === 'title' && result['title'] === undefined) {
      result['title'] = decodeBasicEntities(html.slice(token.contentStart, token.contentEnd)).replace(/\s{2,}/g, ' ').trim();
      continue;
    }
    if (token.kind !== 'tag' || token.closing || token.name !== 'meta') continue;
    const attributes = tagAttributes(token.attributes);
    const content = attributes.get('content');
    if (content === undefined) continue;
    const name = attributes.get('name');
    if (name && /^\w/.test(name)) result[name] = content;
    const property = attributes.get('property');
    if (property?.startsWith('og:')) result[property] = content;
  }
  return JSON.stringify(result, null, 2);
}

/** Whether the whole body is JSON by the JSON grammar, not by its first character. */
function parsesAsJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

export function sniffContentType(contentType: string, body: string): string {
  const isMissing = !contentType || /application\/octet-stream/i.test(contentType);
  if (!isMissing) return contentType;

  const sample = body.slice(0, 512).trimStart();
  if (/^<!DOCTYPE\s+html/i.test(sample) || /^<html/i.test(sample)) {
    return 'text/html';
  }
  if (/^<\?xml/i.test(sample)) {
    return 'application/xml';
  }
  if (/^%PDF-/.test(sample)) {
    return 'application/pdf';
  }
  if (/^[{[]/.test(sample) && parsesAsJson(body)) {
    return 'application/json';
  }
  return contentType;
}

/** What an extract produced, with the reason a mode could not do its job. */
export interface ExtractResult {
  readonly content: string;
  /** `json`: the body is not JSON; it is returned as written. */
  readonly jsonParseError?: string | undefined;
  /** `pdf`: no text could be read from the response. */
  readonly pdfError?: string | undefined;
}

export interface ExtractOptions {
  readonly selectors?: string[] | undefined;
  /** The response bytes, kept for `pdf`: a PDF is binary and a text decode loses it. */
  readonly bytes?: Uint8Array | undefined;
  /** The body was cut at max_content_length. */
  readonly truncated?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function extractPdf(contentType: string, options: ExtractOptions): Promise<ExtractResult> {
  if (!/application\/pdf/i.test(contentType)) {
    return { content: '', pdfError: `the response is ${contentType || 'of no stated type'}, not a PDF; fetch it with another extract mode` };
  }
  if (!options.bytes) return { content: '', pdfError: 'the response bytes were not kept, so the PDF could not be read' };
  try {
    const { pages } = await readMultimodalPdf(Buffer.from(options.bytes), () => options.signal?.throwIfAborted());
    return { content: pages.map((text, index) => `--- page ${index + 1} ---\n${text}`).join('\n\n') };
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return {
      content: '',
      pdfError: options.truncated
        ? `the PDF was cut at max_content_length, so it could not be read (${reason}); fetch it again with a larger max_content_length`
        : reason,
    };
  }
}

/**
 * The body in the requested extract mode, with the reason when the mode could
 * not do its job. `readable` and `summary` are read by Jev (page-reading.ts);
 * `pdf` reads the response bytes with the local PDF reader; every other mode
 * follows the format's grammar.
 */
export async function applyExtractDetailed(
  body: string,
  contentType: string,
  mode: FetchExtractMode,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const effectiveContentType = sniffContentType(contentType, body);
  const isHtml = /text\/html/i.test(effectiveContentType);

  switch (mode) {
    case 'raw':
      return { content: body };
    case 'text':
      return { content: isHtml ? stripHtml(body) : body };
    case 'json':
      try {
        return { content: JSON.stringify(JSON.parse(body), null, 2) };
      } catch (error) {
        return { content: body, jsonParseError: `${error instanceof Error ? error.message : String(error)} (content type ${effectiveContentType || 'not stated'})` };
      }
    case 'markdown':
      return { content: isHtml ? htmlToMarkdown(body) : body };
    case 'readable':
      return { content: isHtml ? await readReadable(body) : body };
    case 'code_blocks':
      return { content: isHtml ? extractCodeBlocks(body) : body };
    case 'links':
      return { content: isHtml ? extractLinks(body) : '' };
    case 'metadata':
      return { content: isHtml ? extractMetadata(body) : '{}' };
    case 'structured': {
      const selectors = options.selectors ?? [];
      if (selectors.length === 0) return { content: JSON.stringify([]) };
      return { content: isHtml ? extractStructured(body, selectors) : JSON.stringify([]) };
    }
    case 'tables':
      return { content: isHtml ? extractTables(body) : JSON.stringify([]) };
    case 'pdf':
      return extractPdf(effectiveContentType, options);
    case 'summary':
      return { content: await readSummary(body, isHtml) };
    default:
      return { content: body };
  }
}

/** The body in the requested extract mode, as text. */
export async function applyExtract(
  body: string,
  contentType: string,
  mode: FetchExtractMode,
  opts?: ExtractOptions | undefined,
): Promise<string> {
  return (await applyExtractDetailed(body, contentType, mode, opts)).content;
}
