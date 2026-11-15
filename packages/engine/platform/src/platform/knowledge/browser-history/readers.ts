import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { copyLockedBrowserSqlite } from './locked-db.js';
import { loadOptionalDependency } from '../../utils/optional-dependency.js';
import type {
  BrowserBookmarkEntry,
  BrowserHistoryEntry,
  BrowserKnowledgeEntry,
  BrowserKnowledgeProfile,
} from './types.js';

interface BplistParser {
  parseFileSync<T = unknown>(path: string): T[];
}

/**
 * `bplist-parser` is an optionalDependency, and only Safari bookmarks, a
 * binary plist, need it. A static import made the whole module, and therefore
 * every graph that reaches browser knowledge, unloadable when the package is
 * absent: the same class of failure the `bun:sqlite` note below describes, and
 * the one utils/optional-dependency.ts records for the daemon.
 */
async function loadBplistParser(): Promise<BplistParser> {
  const loaded = await loadOptionalDependency('bplist-parser', () => import('bplist-parser'));
  if (!loaded.available) throw new Error(loaded.reason);
  const namespace = loaded.module as { readonly default?: unknown };
  return (namespace.default ?? loaded.module) as unknown as BplistParser;
}

// bun:sqlite is a Bun-only builtin; a static import makes this module unloadable
// under any non-Bun runtime (Node's ESM linker rejects the `bun:` scheme at link
// time, breaking the release install-smoke check and any Node import of the
// surfaces that transitively reach this module). Resolve the Database constructor
// lazily via require so the `bun:` specifier stays off the static import graph,
// it is only pulled on the Bun-only code path that opens a browser database.
let bunDatabaseCtor: typeof import('bun:sqlite').Database | null = null;
function bunSqliteDatabase(): typeof import('bun:sqlite').Database {
  return (bunDatabaseCtor ??= createRequire(import.meta.url)('bun:sqlite').Database);
}

type BrowserDb = InstanceType<typeof import('bun:sqlite').Database>;

/** Copy a browser database once (it is locked while the browser runs), open it read-only, and clean up after `read`. */
async function withBrowserDb<T>(path: string, read: (db: BrowserDb) => T): Promise<T> {
  const copy = await copyLockedBrowserSqlite(path);
  try {
    const db = new (bunSqliteDatabase())(copy.copiedDbPath, { readonly: true });
    try { return read(db); } finally { db.close(); }
  } finally {
    await copy.cleanup();
  }
}

export interface BrowserKnowledgeReadOptions {
  readonly limit?: number | undefined;
  readonly sinceMs?: number | undefined;
  readonly sourceKinds?: readonly ('history' | 'bookmark')[] | undefined;
}

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;
const MAC_ABSOLUTE_TIME_OFFSET_S = 978_307_200;

function chromiumMicrosToMs(micros: number): number {
  return Math.floor(micros / 1000) - CHROMIUM_EPOCH_OFFSET_MS;
}

function msToChromiumMicros(ms: number): number {
  return Math.floor((ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000);
}

function geckoMicrosToMs(micros: number): number {
  return Math.floor(micros / 1000);
}

function macAbsoluteTimeToMs(seconds: number): number {
  return Math.floor((seconds + MAC_ABSOLUTE_TIME_OFFSET_S) * 1000);
}

function msToMacAbsoluteSeconds(ms: number): number {
  return Math.floor(ms / 1000) - MAC_ABSOLUTE_TIME_OFFSET_S;
}

function cleanOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function decodeChromiumTransition(raw: number): string {
  return ({
    0: 'LINK',
    1: 'TYPED',
    2: 'AUTO_BOOKMARK',
    3: 'AUTO_SUBFRAME',
    4: 'MANUAL_SUBFRAME',
    5: 'GENERATED',
    6: 'START_PAGE',
    7: 'FORM_SUBMIT',
    8: 'RELOAD',
    9: 'KEYWORD',
    10: 'KEYWORD_GENERATED',
  } as Record<number, string>)[raw & 0xff] ?? 'UNKNOWN';
}

function decodeGeckoVisitType(visitType: number): string {
  return ({
    1: 'LINK',
    2: 'TYPED',
    3: 'BOOKMARK',
    4: 'EMBED',
    5: 'PERMANENT_REDIRECT',
    6: 'TEMPORARY_REDIRECT',
    7: 'DOWNLOAD',
    8: 'FRAMED_LINK',
    9: 'RELOAD',
  } as Record<number, string>)[visitType] ?? 'UNKNOWN';
}

function normalizeLimit(limit: number | undefined, fallback = 1000): number {
  const candidate = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
  return Math.max(1, Math.min(50_000, Math.floor(candidate)));
}

type ChromiumVisitRow = { id: number; url: string | null; title: string | null; visit_count: number; visit_time: number; transition: number };

/** Only the newest `limit` visits, joined to their URL rows; the rest of the tables stay on disk. */
async function readChromiumHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserHistoryEntry[]> {
  if (!profile.historyPath) return [];
  const limit = normalizeLimit(options.limit);
  const since = typeof options.sinceMs === 'number' ? msToChromiumMicros(options.sinceMs) : 0;
  return withBrowserDb(profile.historyPath, (db) => db.query<ChromiumVisitRow, [number, number]>(
    `SELECT u.id, u.url, u.title, u.visit_count, v.visit_time, v.transition
     FROM visits v
     JOIN urls u ON u.id = v.url
     WHERE v.visit_time >= ?
     ORDER BY v.visit_time DESC
     LIMIT ?`,
  ).all(since, limit).flatMap((visit) => {
    if (!visit.url) return [];
    return [{
      sourceKind: 'history' as const,
      url: visit.url,
      ...(cleanOptionalText(visit.title) ? { title: cleanOptionalText(visit.title) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      visitedAtMs: chromiumMicrosToMs(visit.visit_time),
      visitCount: visit.visit_count,
      transition: decodeChromiumTransition(visit.transition),
      rawId: visit.id,
    }];
  }));
}

interface ChromiumBookmarkNode {
  readonly id?: string | undefined;
  readonly type?: 'url' | 'folder' | undefined;
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly date_added?: string | undefined;
  readonly children?: readonly ChromiumBookmarkNode[] | undefined;
}

function walkChromiumBookmarkNode(
  profile: BrowserKnowledgeProfile,
  node: ChromiumBookmarkNode,
  folders: readonly string[],
  out: BrowserBookmarkEntry[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (node.type === 'url') {
    const url = cleanOptionalText(node.url);
    if (!url) return;
    const micros = Number(node.date_added ?? 0);
    out.push({
      sourceKind: 'bookmark',
      url,
      ...(cleanOptionalText(node.name) ? { title: cleanOptionalText(node.name) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      ...(folders.length ? { folderPath: `/${folders.join('/')}` } : {}),
      ...(Number.isFinite(micros) && micros > 0 ? { addedAtMs: chromiumMicrosToMs(micros) } : {}),
      ...(node.id ? { rawId: node.id } : {}),
    });
    return;
  }
  if (node.type === 'folder') {
    const nextFolders = cleanOptionalText(node.name) ? [...folders, (node.name ?? '').trim()] : [...folders];
    for (const child of node.children ?? []) {
      walkChromiumBookmarkNode(profile, child, nextFolders, out, limit);
      if (out.length >= limit) return;
    }
  }
}

async function readChromiumBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserBookmarkEntry[]> {
  if (!profile.bookmarksPath) return [];
  const limit = normalizeLimit(options.limit);
  const parsed = JSON.parse(await readFile(profile.bookmarksPath, 'utf8')) as {
    roots?: Record<string, ChromiumBookmarkNode | undefined> | undefined;
  };
  const out: BrowserBookmarkEntry[] = [];
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = parsed.roots?.[key];
    if (!root) continue;
    walkChromiumBookmarkNode(profile, root, [], out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

type GeckoVisitRow = {
  place_id: number;
  url: string;
  title: string | null;
  visit_count: number;
  visit_date: number;
  visit_type: number;
};

function readGeckoHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions, db: BrowserDb): BrowserHistoryEntry[] {
  const since = typeof options.sinceMs === 'number' ? Math.floor(options.sinceMs * 1000) : 0;
  const rows = db.query<GeckoVisitRow, [number, number]>(
    `SELECT p.id AS place_id, p.url, p.title, p.visit_count, h.visit_date, h.visit_type
     FROM moz_historyvisits h
     JOIN moz_places p ON p.id = h.place_id
     WHERE p.hidden = 0 AND h.visit_date >= ?
     ORDER BY h.visit_date DESC
     LIMIT ?`,
  ).all(since, normalizeLimit(options.limit));
  return rows.map((row) => ({
    sourceKind: 'history',
    url: row.url,
    ...(cleanOptionalText(row.title) ? { title: cleanOptionalText(row.title) } : {}),
    browser: profile.browser,
    family: profile.family,
    profileName: profile.profileName,
    profilePath: profile.profilePath,
    visitedAtMs: geckoMicrosToMs(row.visit_date),
    visitCount: row.visit_count,
    transition: decodeGeckoVisitType(row.visit_type),
    rawId: row.place_id,
  }));
}

type GeckoBookmarkRow = { id: number; type: number; parent: number; title: string | null; fk: number | null; dateAdded: number };
type GeckoBookmarkPlaceRow = GeckoBookmarkRow & { url: string | null; place_title: string | null };

const GECKO_ROOT_LABELS: Record<number, string> = {
  1: 'root',
  2: 'Bookmarks Menu',
  3: 'Bookmarks Toolbar',
  4: 'Tags',
  5: 'Other Bookmarks',
  6: 'Mobile Bookmarks',
};

function geckoFolderPath(parent: number, rows: Map<number, GeckoBookmarkRow>): string | undefined {
  const segments: string[] = [];
  const visited = new Set<number>();
  let current = parent;
  while (current > 0 && !visited.has(current)) {
    visited.add(current);
    const row = rows.get(current);
    if (!row) break;
    const root = GECKO_ROOT_LABELS[current]!;
    if (root) {
      segments.unshift(root);
      break;
    }
    if (row.title) segments.unshift(row.title);
    current = row.parent;
  }
  return segments.length ? `/${segments.join('/')}` : undefined;
}

/** The first `limit` bookmarks joined to their places; folders (a small table slice) give each its path. */
function readGeckoBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions, db: BrowserDb): BrowserBookmarkEntry[] {
  const folders = db.query<GeckoBookmarkRow, []>('SELECT id, type, parent, title, fk, dateAdded FROM moz_bookmarks WHERE type = 2').all();
  const rows = db.query<GeckoBookmarkPlaceRow, [number]>(
    `SELECT b.id, b.type, b.parent, b.title, b.fk, b.dateAdded, p.url, p.title AS place_title
     FROM moz_bookmarks b
     JOIN moz_places p ON p.id = b.fk
     WHERE b.type = 1 AND p.url IS NOT NULL
     ORDER BY b.id
     LIMIT ?`,
  ).all(normalizeLimit(options.limit));
  const rowById = new Map(folders.map((row) => [row.id, row]));
  const out: BrowserBookmarkEntry[] = [];
  for (const row of rows) {
    if (!row.url) continue;
    const addedAtMs = Math.max(0, Math.floor(row.dateAdded / 1000));
    out.push({
      sourceKind: 'bookmark',
      url: row.url,
      ...(cleanOptionalText(row.title ?? row.place_title) ? { title: cleanOptionalText(row.title ?? row.place_title) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      ...(geckoFolderPath(row.parent, rowById) ? { folderPath: geckoFolderPath(row.parent, rowById) } : {}),
      ...(addedAtMs > 0 ? { addedAtMs } : {}),
      rawId: row.id,
    });
  }
  return out;
}

type SafariHistoryVisit = { id: number; url: string | null; visit_count: number; item_title: string | null; visit_time: number; title: string | null };
type EphyUrlRow = { id: number; url: string; title: string | null; visit_count: number; last_visit_time: number };

async function readWebKitHistory(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserHistoryEntry[]> {
  if (!profile.historyPath) return [];
  const copy = await copyLockedBrowserSqlite(profile.historyPath);
  try {
    const db = new (bunSqliteDatabase())(copy.copiedDbPath, { readonly: true });
    try {
      if (profile.browser === 'epiphany') {
        const since = typeof options.sinceMs === 'number' ? Math.floor(options.sinceMs / 1000) : 0;
        const rows = db.query<EphyUrlRow, [number, number]>(
          'SELECT id, url, title, visit_count, last_visit_time FROM urls WHERE last_visit_time >= ? ORDER BY last_visit_time DESC LIMIT ?',
        ).all(since, normalizeLimit(options.limit));
        return rows.map((row) => ({
          sourceKind: 'history',
          url: row.url,
          ...(cleanOptionalText(row.title) ? { title: cleanOptionalText(row.title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          visitedAtMs: row.last_visit_time * 1000,
          visitCount: row.visit_count,
          rawId: row.id,
        }));
      }
      const since = typeof options.sinceMs === 'number' ? msToMacAbsoluteSeconds(options.sinceMs) : 0;
      const rows = db.query<SafariHistoryVisit, [number, number]>(
        `SELECT i.id, i.url, i.visit_count, i.title AS item_title, v.visit_time, v.title
         FROM history_visits v
         JOIN history_items i ON i.id = v.history_item
         WHERE v.visit_time >= ?
         ORDER BY v.visit_time DESC
         LIMIT ?`,
      ).all(since, normalizeLimit(options.limit));
      return rows.flatMap((visit) => {
        if (!visit.url) return [];
        return [{
          sourceKind: 'history' as const,
          url: visit.url,
          ...(cleanOptionalText(visit.title ?? visit.item_title) ? { title: cleanOptionalText(visit.title ?? visit.item_title) } : {}),
          browser: profile.browser,
          family: profile.family,
          profileName: profile.profileName,
          profilePath: profile.profilePath,
          visitedAtMs: macAbsoluteTimeToMs(visit.visit_time),
          visitCount: visit.visit_count,
          rawId: visit.id,
        }];
      });
    } finally {
      db.close();
    }
  } finally {
    await copy.cleanup();
  }
}

interface WebKitBookmarkNode {
  readonly WebBookmarkType?: string | undefined;
  readonly URLString?: string | undefined;
  readonly URIDictionary?: { readonly title?: string } | undefined;
  readonly Title?: string | undefined;
  readonly Children?: readonly WebKitBookmarkNode[] | undefined;
  readonly WebBookmarkDateAdded?: number | undefined;
}

function walkWebKitBookmarkNode(
  profile: BrowserKnowledgeProfile,
  node: WebKitBookmarkNode,
  folderPath: string,
  out: BrowserBookmarkEntry[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
    const url = cleanOptionalText(node.URLString);
    if (!url) return;
    out.push({
      sourceKind: 'bookmark',
      url,
      ...(cleanOptionalText(node.URIDictionary?.title) ? { title: cleanOptionalText(node.URIDictionary?.title) } : {}),
      browser: profile.browser,
      family: profile.family,
      profileName: profile.profileName,
      profilePath: profile.profilePath,
      ...(folderPath ? { folderPath } : {}),
      ...(typeof node.WebBookmarkDateAdded === 'number' ? { addedAtMs: macAbsoluteTimeToMs(node.WebBookmarkDateAdded) } : {}),
    });
    return;
  }
  if (node.WebBookmarkType === 'WebBookmarkTypeList') {
    const next = cleanOptionalText(node.Title) ? `${folderPath}/${(node.Title ?? '').trim()}` : folderPath;
    for (const child of node.Children ?? []) {
      walkWebKitBookmarkNode(profile, child, next, out, limit);
      if (out.length >= limit) return;
    }
  }
}

async function readWebKitBookmarks(profile: BrowserKnowledgeProfile, options: BrowserKnowledgeReadOptions): Promise<BrowserBookmarkEntry[]> {
  if (!profile.bookmarksPath || profile.browser === 'epiphany') return [];
  const bplistParser = await loadBplistParser();
  const [root] = bplistParser.parseFileSync<WebKitBookmarkNode>(profile.bookmarksPath);
  const out: BrowserBookmarkEntry[] = [];
  for (const child of root?.Children ?? []) {
    walkWebKitBookmarkNode(profile, child, '', out, normalizeLimit(options.limit));
    if (out.length >= normalizeLimit(options.limit)) break;
  }
  return out;
}

export async function readBrowserKnowledgeProfile(
  profile: BrowserKnowledgeProfile,
  options: BrowserKnowledgeReadOptions = {},
): Promise<BrowserKnowledgeEntry[]> {
  const kinds = new Set(options.sourceKinds ?? ['history', 'bookmark']);
  const limit = normalizeLimit(options.limit, 2000);
  const history: BrowserKnowledgeEntry[] = [];
  const bookmarks: BrowserKnowledgeEntry[] = [];
  let geckoBookmarksRead = false;
  if (kinds.has('history')) {
    if (profile.family === 'chromium') history.push(...await readChromiumHistory(profile, options));
    if (profile.family === 'gecko' && profile.historyPath) {
      // Firefox keeps history and bookmarks in the same places.sqlite: copy it once for both.
      const bookmarksPath = profile.bookmarksPath ?? profile.historyPath;
      const both = kinds.has('bookmark') && bookmarksPath === profile.historyPath;
      await withBrowserDb(profile.historyPath, (db) => {
        history.push(...readGeckoHistory(profile, options, db));
        if (both) bookmarks.push(...readGeckoBookmarks(profile, options, db));
      });
      if (both) geckoBookmarksRead = true;
    }
    if (profile.family === 'webkit') history.push(...await readWebKitHistory(profile, options));
  }
  if (kinds.has('bookmark')) {
    if (profile.family === 'chromium') bookmarks.push(...await readChromiumBookmarks(profile, options));
    const geckoBookmarksPath = profile.bookmarksPath ?? profile.historyPath;
    if (profile.family === 'gecko' && !geckoBookmarksRead && geckoBookmarksPath) {
      bookmarks.push(...await withBrowserDb(geckoBookmarksPath, (db) => readGeckoBookmarks(profile, options, db)));
    }
    if (profile.family === 'webkit') bookmarks.push(...await readWebKitBookmarks(profile, options));
  }
  // The limit applies to each kind. A shared cut would let a long visit
  // history, which comes first, crowd every bookmark out.
  return [...history.slice(0, limit), ...bookmarks.slice(0, limit)];
}
