/**
 * page-blocks.ts, an HTML page carved into the text units Jev reads for the
 * fetch tool's `readable` and `summary` modes (fetch/page-reading.ts).
 *
 * Nothing here decides what is content. It follows the HTML grammar only:
 * the document head, comments, `script`, `style`, `noscript`, `template`,
 * `textarea`, `svg` and `iframe` are not rendered text; block-level elements
 * and `br` end one run of text and start the next, while an inline element
 * adds nothing (`un<b>believ</b>able` is one word); character references
 * decode to the characters they name; a heading keeps its level until its own
 * closing tag. Every run keeps the path of the grouping elements it sits in
 * (tag, id and class, as written), which Jev sees beside the text. The page
 * is read by the one linear scanner (markup.ts).
 */
import { scanMarkup } from './markup.js';

/** Grouping elements: a run of text is keyed by the chain of these it sits in. */
const REGION_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure',
  'footer', 'form', 'header', 'main', 'menu', 'nav', 'ol', 'pre', 'section', 'table', 'ul',
]);

/** Block-level elements inside a region that end one run of text and start another. */
const UNIT_TAGS = new Set([
  'br', 'caption', 'dd', 'dt', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'legend', 'li',
  'p', 'summary', 'td', 'th', 'tr',
]);

const HEADING = /^h([1-6])$/;

/** Most characters of one element label (tag, id and classes) carried in a path. */
const MAX_LABEL_CHARS = 80;

/** One run of rendered text: its text, the region path it sits in, and its heading level when it is a heading. */
export interface PageUnit {
  readonly text: string;
  readonly path: string;
  readonly headingLevel?: number | undefined;
}

/** Consecutive units in the same region, joined: one block for the readable reading. */
export interface PageBlock {
  readonly path: string;
  readonly text: string;
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  middot: '\u00b7', bull: '\u2022', times: '\u00d7', deg: '\u00b0',
};

/** Decodes numeric character references and the common named ones. */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_REFERENCES[ref.toLowerCase()] ?? match;
  });
}

/** The text of the document's `<title>`, or empty. */
export function pageTitle(html: string): string {
  for (const token of scanMarkup(html)) {
    if (token.kind === 'element' && token.name === 'title') {
      return decodeCharacterReferences(html.slice(token.contentStart, token.contentEnd)).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/** Elements whose content is never rendered as page text. */
const NOT_RENDERED: ReadonlySet<string> = new Set(['head', 'noscript', 'template', 'svg', 'iframe']);

function elementLabel(tag: string, attributes: string): string {
  const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.trim();
  const classes = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const label = `${tag}${id ? `#${id}` : ''}${classes.map((name) => `.${name}`).join('')}`;
  return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS)}...`;
}

/** The page's runs of rendered text, in document order. When a `<body>` is written, only its content counts. */
export function pageUnits(html: string): PageUnit[] {
  let units: PageUnit[] = [];
  const regions: { readonly tag: string; readonly label: string }[] = [];
  let text = '';
  let openHeading: number | undefined;

  const flush = (): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      const path = regions.length > 0 ? regions.map((region) => region.label).join(' > ') : 'body';
      units.push({ text: cleaned, path, ...(openHeading === undefined ? {} : { headingLevel: openHeading }) });
    }
    text = '';
  };

  for (const token of scanMarkup(html, { skip: NOT_RENDERED })) {
    if (token.kind === 'text') {
      text += decodeCharacterReferences(html.slice(token.start, token.end));
      continue;
    }
    if (token.kind !== 'tag') continue;
    const tag = token.name;
    if (tag === 'body') {
      flush();
      if (token.closing) break;
      // Text written before the body is not part of the rendered page.
      units = [];
      regions.length = 0;
      openHeading = undefined;
      continue;
    }
    const isRegion = REGION_TAGS.has(tag);
    if (!isRegion && !UNIT_TAGS.has(tag)) continue;
    flush();
    const heading = HEADING.exec(tag);
    if (heading) openHeading = token.closing ? undefined : Number(heading[1]);
    if (!isRegion) continue;
    if (!token.closing && !token.selfClosing) {
      regions.push({ tag, label: elementLabel(tag, token.attributes) });
      continue;
    }
    if (token.closing) {
      const open = regions.map((region) => region.tag).lastIndexOf(tag);
      if (open >= 0) regions.length = open;
    }
  }
  flush();
  return units;
}

/** Consecutive units that share a region path, joined line by line. */
export function pageBlocks(units: readonly PageUnit[]): PageBlock[] {
  const blocks: { path: string; lines: string[] }[] = [];
  for (const unit of units) {
    const last = blocks[blocks.length - 1];
    if (last && last.path === unit.path) last.lines.push(unit.text);
    else blocks.push({ path: unit.path, lines: [unit.text] });
  }
  return blocks.map(({ path, lines }) => ({ path, text: lines.join('\n') }));
}
