import type { KnowledgeBookmarkSeed } from './types.js';

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeFolderPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/[/>|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' / ');
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function parseJsonBookmarks(value: unknown, inheritedFolder?: string): KnowledgeBookmarkSeed[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return [{ url: trimmed, ...(inheritedFolder ? { folderPath: inheritedFolder } : {}) }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseJsonBookmarks(entry, inheritedFolder));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  // A named container extends the folder it sits in, as in the Netscape format.
  const containerName = typeof record.name === 'string' && !record.url && !record.href && !record.uri
    ? normalizeFolderPath(record.name) : undefined;
  const folderName = normalizeFolderPath(
    typeof record.folderPath === 'string' ? record.folderPath
      : typeof record.folder === 'string' ? record.folder
        : containerName ? [inheritedFolder, containerName].filter(Boolean).join(' / ')
          : inheritedFolder,
  );
  const url = typeof record.url === 'string'
    ? record.url
    : typeof record.href === 'string'
      ? record.href
      : typeof record.uri === 'string'
        ? record.uri
        : undefined;
  const title = typeof record.title === 'string'
    ? record.title
    : typeof record.name === 'string'
      ? record.name
      : undefined;
  const metadata = typeof record.metadata === 'object' && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : {};
  const tags = normalizeTags(record.tags);
  // Chromium's Bookmarks file keeps its containers (bookmark_bar, other,
  // synced) as the values of a `roots` object; each carries a name and children.
  const roots = record.roots && typeof record.roots === 'object' && !Array.isArray(record.roots)
    ? Object.values(record.roots as Record<string, unknown>) : [];
  const nested = [
    ...parseJsonBookmarks(record.children ?? record.items ?? [], folderName),
    ...parseJsonBookmarks(roots, folderName),
  ];
  const current = url && /^https?:\/\//i.test(url)
    ? [{
        url,
        ...(title?.trim() ? { title: title.trim() } : {}),
        ...(folderName ? { folderPath: folderName } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        metadata,
      } satisfies KnowledgeBookmarkSeed]
    : [];
  return [...current, ...nested];
}

function parseNetscapeBookmarks(content: string): KnowledgeBookmarkSeed[] {
  const entries: KnowledgeBookmarkSeed[] = [];
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const folderMatch = line.match(/<H3[^>]*>([\s\S]*?)<\/H3>/i);
    if (folderMatch?.[1]) {
      pendingFolder = decodeHtml((folderMatch[1] ?? '').replace(/<[^>]+>/g, ''));
      continue;
    }

    if (/<DL/i.test(line)) {
      if (pendingFolder) {
        folderStack.push(pendingFolder);
        pendingFolder = null;
      }
      continue;
    }

    if (/<\/DL>/i.test(line)) {
      folderStack.pop();
      continue;
    }

    const linkMatch = line.match(/<A\s+([^>]*?)>([\s\S]*?)<\/A>/i);
    if (!linkMatch) continue;

    const attrs = linkMatch[1] ?? '';
    const href = attrs.match(/\bHREF=["']([^"']+)["']/i)?.[1];
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const tags = attrs.match(/\bTAGS=["']([^"']+)["']/i)?.[1];
    const addDate = attrs.match(/\bADD_DATE=["']([^"']+)["']/i)?.[1];
    const title = decodeHtml((linkMatch[2] ?? '').replace(/<[^>]+>/g, ''));
    const folderPath = folderStack.length > 0 ? folderStack.join(' / ') : undefined;
    entries.push({
      url: href,
      ...(title ? { title } : {}),
      ...(folderPath ? { folderPath } : {}),
      ...(tags ? { tags: normalizeTags(tags) } : {}),
      metadata: {
        ...(addDate ? { addDate } : {}),
      },
    });
  }

  return entries;
}

function parseUrlList(content: string): KnowledgeBookmarkSeed[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => /^https?:\/\//i.test(line))
    .map((url) => ({ url }));
}

/**
 * The bookmarks in an export: JSON (including Chromium's Bookmarks file),
 * Netscape HTML, or a list of URLs one per line. Empty input yields none.
 * Input that is not empty but holds no http(s) bookmark is refused with the
 * format it was read as, so it never looks like an empty, successful import.
 */
export function parseBookmarkSeeds(content: string): KnowledgeBookmarkSeed[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  let format: string;
  let seeds: KnowledgeBookmarkSeed[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      // A truncated export must not look like an empty, successful import.
      throw new Error(`Bookmark input looks like JSON but could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    format = 'JSON';
    seeds = parseJsonBookmarks(parsed);
  } else if (/<A\s/i.test(trimmed) && /<DL/i.test(trimmed)) {
    format = 'Netscape bookmark HTML';
    seeds = parseNetscapeBookmarks(trimmed);
  } else {
    format = 'a URL list';
    seeds = parseUrlList(trimmed);
  }
  if (seeds.length === 0) {
    throw new Error(`Bookmark input was read as ${format}, but no http(s) bookmark was found in it; nothing was imported.`);
  }
  return seeds;
}
