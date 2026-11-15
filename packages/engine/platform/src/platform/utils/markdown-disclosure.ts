import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type MarkdownFrontmatterValue = string | string[];

export interface MarkdownFrontmatter {
  readonly [key: string]: MarkdownFrontmatterValue | undefined;
}

export interface MarkdownDisclosure {
  readonly path: string;
  readonly metadata: MarkdownFrontmatter;
  readonly body: string;
  readonly includes: readonly string[];
  readonly sections: readonly string[];
  readonly preview: string;
}


export function parseMarkdownFrontmatter(content: string): {
  metadata: MarkdownFrontmatter;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { metadata: {}, body: content };
  }

  const secondDash = trimmed.indexOf('\n---', 3);
  if (secondDash === -1) {
    return { metadata: {}, body: content };
  }

  const rawFrontmatter = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 4).trimStart();
  return {
    metadata: parseSimpleYamlFrontmatter(rawFrontmatter),
    body,
  };
}

function parseSimpleYamlFrontmatter(frontmatter: string): MarkdownFrontmatter {
  const result: Record<string, MarkdownFrontmatterValue> = {};
  const lines = frontmatter.split('\n');
  let currentKey: string | null = null;
  let listBuffer: string[] = [];
  let collectingList = false;

  const flushList = () => {
    if (collectingList && currentKey) {
      result[currentKey] = listBuffer.slice();
    }
    collectingList = false;
    currentKey = null;
    listBuffer = [];
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      if (collectingList) flushList();
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (collectingList && listItem) {
      listBuffer.push(stripWrappingQuotes((listItem[1] ?? '').trim()));
      continue;
    }

    const kv = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;

    if (collectingList) flushList();

    currentKey = kv[1] ?? '';
    const rawValue = (kv[2] ?? '').trim();

    if (!rawValue) {
      collectingList = true;
      continue;
    }

    const inlineList = rawValue.match(/^\[(.*)\]$/);
    if (inlineList) {
      result[currentKey] = inlineList[1]!
        .split(',')
        .map((part) => stripWrappingQuotes(part.trim()))
        .filter(Boolean);
      currentKey = null;
      continue;
    }

    result[currentKey] = stripWrappingQuotes(rawValue);
    currentKey = null;
  }

  if (collectingList) flushList();

  return result;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

export function normalizeFrontmatterList(value: MarkdownFrontmatterValue | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean);
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function collectMarkdownReferences(body: string): string[] {
  const refs: string[] = [];
  const refRegex = /^\s*@([A-Za-z0-9_./#-]+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(body)) !== null) {
    refs.push(match[1]!);
  }
  return refs;
}

export function extractMarkdownSections(body: string): string[] {
  const sections: string[] = [];
  const headingRegex = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(body)) !== null) {
    sections.push((match[2] ?? '').trim());
  }
  return sections;
}

export function extractMarkdownPreview(body: string, maxChars = 220): string {
  const cleaned = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('@') && !line.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function readMarkdownDisclosure(filePath: string): MarkdownDisclosure {
  const resolvedPath = resolve(filePath);
  const raw = readFileSync(resolvedPath, 'utf-8');
  const { metadata, body } = parseMarkdownFrontmatter(raw);
  return {
    path: resolvedPath,
    metadata,
    body,
    includes: collectMarkdownReferences(body),
    sections: extractMarkdownSections(body),
    preview: extractMarkdownPreview(body),
  };
}

/**
 * Expands `@file` lines. An include must live under the directory of the file
 * being materialized (links resolved), so a skill or archetype that arrives with
 * a cloned repository cannot splice `@/etc/...` or `@../../.env` into the text a
 * model reads; a refused include is replaced by a visible marker. A line naming
 * a file that does not exist is kept as written, since it is text such as
 * `@mention`.
 */
export function materializeMarkdownBody(filePath: string, body?: string): string {
  const resolvedPath = resolve(filePath);
  const sourceBody = body ?? readMarkdownDisclosure(resolvedPath).body;
  let root: string;
  try { root = realpathSync(dirname(resolvedPath)); } catch { root = dirname(resolvedPath); }
  return resolveMarkdownIncludes(resolvedPath, sourceBody, new Set<string>(), root, 0, { expanded: 0, chars: 0 });
}

// Nesting and total expansions are bounded: without the bounds a few small
// files that each repeat an include ten times expand exponentially.
const MAX_INCLUDE_DEPTH = 5;
const MAX_INCLUDE_EXPANSIONS = 200;
// Total size of all included bodies; the expansion count alone lets one large
// file included many times multiply into hundreds of megabytes.
const MAX_INCLUDE_CHARS = 1_000_000;

function includeSkipped(includeTarget: string): string {
  const file = includeTarget.split('#')[0];
  return `[include skipped: ${file} exceeds the include limit (${MAX_INCLUDE_DEPTH} levels, ${MAX_INCLUDE_EXPANSIONS} includes, `
    + `${MAX_INCLUDE_CHARS.toLocaleString('en-US')} characters); read ${file} directly if it is needed]`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `root` is already a real path, resolved once per materialization. */
function isInsideDirectory(root: string, candidate: string): boolean {
  try {
    const rel = relative(root, realpathSync(candidate));
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  } catch {
    return false;
  }
}

function resolveMarkdownIncludes(
  sourcePath: string,
  body: string,
  chain: Set<string>,
  root: string,
  depth: number,
  budget: { expanded: number; chars: number },
): string {

  const resolvedSourcePath = resolve(sourcePath);
  // The chain holds only the files being expanded right now, so a cycle is cut
  // while the same fragment included twice from siblings is still expanded.
  if (chain.has(resolvedSourcePath)) return '';
  chain.add(resolvedSourcePath);

  const baseDir = dirname(resolvedSourcePath);
  const lines = body.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@@')) {
      const marker = line.indexOf('@@');
      result.push(`${line.slice(0, marker)}${line.slice(marker + 1)}`);
      continue;
    }

    const includeMatch = trimmed.match(/^@([A-Za-z0-9_./#-]+)\s*$/);
    if (!includeMatch) {
      result.push(line);
      continue;
    }

    const includeTarget = includeMatch[1]!;
    const includePath = resolve(baseDir, includeTarget.split('#')[0]!);
    if (!isFile(includePath)) {
      result.push(line);
      continue;
    }
    if (!isInsideDirectory(root, includePath)) {
      result.push(`[include refused: ${includeTarget.split('#')[0]} is outside ${basename(root)}/]`);
      continue;
    }

    if (depth >= MAX_INCLUDE_DEPTH || budget.expanded >= MAX_INCLUDE_EXPANSIONS) {
      result.push(includeSkipped(includeTarget));
      continue;
    }
    const included = readMarkdownDisclosure(includePath);
    if (budget.chars + included.body.length > MAX_INCLUDE_CHARS) {
      result.push(includeSkipped(includeTarget));
      continue;
    }
    budget.expanded += 1;
    budget.chars += included.body.length;
    const materialized = resolveMarkdownIncludes(includePath, included.body, chain, root, depth + 1, budget);
    if (!materialized) continue;
    result.push(materialized);
  }

  chain.delete(resolvedSourcePath);
  return result.join('\n');
}
