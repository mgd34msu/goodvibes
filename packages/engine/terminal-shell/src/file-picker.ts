import { WALK_SKIP_DIRS } from '@goodvibes/engine/platform/platform/utils';
import { readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
export interface FilePickerWorkspace { readonly workingDirectory: string; }

/** The listing walk stops here; past it, a typed query searches the tree itself. */
const LIST_DEPTH_LIMIT = 8;
const LIST_ENTRY_LIMIT = 5000;
/** One query search visits at most this many entries and keeps at most this many matches. */
const QUERY_VISIT_LIMIT = 100_000;
const QUERY_MATCH_LIMIT = 500;

/**
 * FilePickerModal - Fuzzy file finder triggered by @ in the input area.
 * Walks the project directory, fuzzy-matches against the query,
 * and lets the user select a file to insert its path.
 */
export class FilePickerModal {
  constructor(private readonly shellPaths: FilePickerWorkspace) {}

  public active = false;
  public query = '';
  public searchFocused = true;
  public results: string[] = [];
  public selectedIndex = 0;
  /** Position in the prompt where @ was typed, used to replace @query with the selected path */
  public insertPos = 0;
  /** When true, selected file inserts as !@path (inject mode) instead of @path */
  public injectMode = false;

  public allFiles: string[] = [];
  private filesCached = false;
  private cachedRoot: string | undefined;
  private loading: AbortController | undefined;
  public loadError: string | undefined;
  /** True when the walk stopped at its file-count or depth limit, so the list is partial. */
  public truncated = false;
  /** True while a typed query is being searched for in the tree beyond the partial list. */
  public searching = false;
  private searchHits: { readonly query: string; readonly files: readonly string[] } | undefined;
  private searchController: AbortController | undefined;

  private onUpdate: (() => void) | null = null;

  /** True once a walk of this directory has finished, so an empty list means there are no files. */
  get listed(): boolean {
    return this.filesCached;
  }

  /** Set a callback to trigger re-render when file list loads. */
  setOnUpdate(fn: () => void): void {
    this.onUpdate = fn;
  }

  /** Activate the file picker at the given prompt position. */
  open(insertPos: number, injectMode = false): void {
    this.active = true;
    this.query = '';
    this.searchFocused = true;
    this.selectedIndex = 0;
    this.insertPos = insertPos;
    this.injectMode = injectMode;

    this.loading?.abort();
    this.loading = undefined;
    this.loadError = undefined;
    if (this.filesCached && this.cachedRoot === this.shellPaths.workingDirectory) {
      // The last list shows at once; a fresh walk replaces it, so files made since then appear.
      this.updateResults();
      this.startLoad(true);
    } else {
      this.startLoad();
    }
  }

  /**
   * Walk the working directory in the background; results appear when it finishes.
   * `keepVisible` leaves the current list on screen until the new one is ready.
   */
  private startLoad(keepVisible = false): void {
    this.loading?.abort();
    if (!keepVisible) {
      // Show "Loading..." immediately, never filter stale files from another root.
      this.results = [];
      this.allFiles = [];
      this.filesCached = false;
      this.cachedRoot = undefined;
      this.truncated = false;
    }
    this.loadError = undefined;
    const controller = new AbortController();
    const root = this.shellPaths.workingDirectory;
    this.loading = controller;
    // Not tied to `active`: Tab completion loads the list with the picker closed; close() aborts a load it started.
    const current = () => this.loading === controller
      && !controller.signal.aborted && this.shellPaths.workingDirectory === root;
    const assertCurrent = () => {
      if (!current()) controller.abort();
      controller.signal.throwIfAborted();
    };
    void this.loadFiles(root, assertCurrent).then(({ files, truncated }) => {
      if (!current()) return;
      this.allFiles = files;
      this.truncated = truncated;
      this.filesCached = true;
      this.cachedRoot = root;
      this.updateResults();
      this.onUpdate?.();
    }).catch(() => {
      // A refresh that fails leaves the last list in place.
      if (!current() || keepVisible) return;
      this.allFiles = [];
      this.results = [];
      this.filesCached = false;
      this.loadError = 'File listing unavailable. Close and reopen to retry.';
      this.onUpdate?.();
    }).finally(() => { if (this.loading === controller) this.loading = undefined; });
  }

  /** Close the file picker without selecting. */
  close(): void {
    this.loading?.abort();
    this.loading = undefined;
    this.cancelSearch();
    this.loadError = undefined;
    this.truncated = false;
    this.active = false;
    this.query = '';
    this.searchFocused = true;
    this.results = [];
    this.selectedIndex = 0;
    this.injectMode = false;
  }

  /** Update the search query and re-filter results. */
  setQuery(q: string): void {
    this.query = q;
    this.selectedIndex = 0;
    this.updateResults();
    if (this.truncated && q.length > 0) this.startQuerySearch(q);
    else this.cancelSearch();
  }

  /**
   * The paths Tab completion offers for a typed prefix: the listed files, plus
   * the entries of the directory the prefix names, read now, so a path past the
   * listing's limit or a file made during the session still completes. Starts
   * the listing when it was never loaded.
   */
  completionCandidates(prefix: string): string[] {
    const root = this.shellPaths.workingDirectory;
    if (!this.filesCached && !this.loading) this.startLoad();
    const slash = prefix.lastIndexOf('/');
    if (slash < 0) return this.allFiles;
    const dirPart = prefix.slice(0, slash);
    const dir = resolve(root, dirPart);
    if (dir !== root && !dir.startsWith(root + sep)) return this.allFiles;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return this.allFiles;
    }
    const listed = new Set(this.allFiles);
    const extra: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || (entry.isDirectory() && WALK_SKIP_DIRS.has(entry.name))) continue;
      const rel = relative(root, join(dir, entry.name)) + (entry.isDirectory() ? '/' : '');
      if (!listed.has(rel)) extra.push(rel);
    }
    return extra.length === 0 ? this.allFiles : [...this.allFiles, ...extra.sort()];
  }

  private cancelSearch(): void {
    this.searchController?.abort();
    this.searchController = undefined;
    this.searching = false;
  }

  /**
   * The listing stopped at its limit, so search the tree for the typed query:
   * from the deepest directory the query names, or the whole tree, matching
   * the query as a substring of the path. Results join the list when found.
   */
  private startQuerySearch(query: string): void {
    this.cancelSearch();
    const root = this.shellPaths.workingDirectory;
    const controller = new AbortController();
    this.searchController = controller;
    this.searching = true;
    const slash = query.lastIndexOf('/');
    const named = slash > 0 ? resolve(root, query.slice(0, slash)) : root;
    const base = named === root || named.startsWith(root + sep) ? named : root;
    const needle = query.toLowerCase();
    const hits: string[] = [];
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (controller.signal.aborted || depth > 32 || visited >= QUERY_VISIT_LIMIT || hits.length >= QUERY_MATCH_LIMIT) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (controller.signal.aborted || visited >= QUERY_VISIT_LIMIT || hits.length >= QUERY_MATCH_LIMIT) return;
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && WALK_SKIP_DIRS.has(entry.name)) continue;
        visited++;
        const full = join(dir, entry.name);
        const rel = relative(root, full) + (entry.isDirectory() ? '/' : '');
        if (rel.toLowerCase().includes(needle)) hits.push(rel);
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    };
    void walk(base, 0).then(() => {
      if (controller.signal.aborted || this.searchController !== controller || !this.active || this.query !== query) return;
      this.searchController = undefined;
      this.searching = false;
      this.searchHits = { query, files: hits };
      this.updateResults();
      this.onUpdate?.();
    });
  }

  canFocusSearch(): boolean {
    return true;
  }

  focusSearch(): void {
    this.searchFocused = true;
  }

  blurSearch(): void {
    this.searchFocused = false;
  }

  /** Move selection up. */
  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  /** Move selection down. */
  moveDown(): void {
    if (this.selectedIndex < this.results.length - 1) this.selectedIndex++;
  }

  /** Get the currently selected file path, or null if none. */
  getSelected(): string | null {
    if (this.results.length === 0) return null;
    return this.results[this.selectedIndex] ?? null;
  }

  /** Fuzzy match: does the query match the candidate? */
  private fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
    if (query.length === 0) return { match: true, score: 0 };
    const lowerQuery = query.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();

    // Substring match (highest priority)
    const subIdx = lowerCandidate.indexOf(lowerQuery);
    if (subIdx !== -1) {
      // Bonus for matching at start of filename (after last /)
      const lastSlash = lowerCandidate.lastIndexOf('/');
      const filenameStart = lastSlash + 1;
      const isFilenameMatch = subIdx >= filenameStart;
      return { match: true, score: isFilenameMatch ? 100 - subIdx : 50 - subIdx };
    }

    // Character-by-character fuzzy match
    let qi = 0;
    let score = 0;
    for (let ci = 0; ci < lowerCandidate.length && qi < lowerQuery.length; ci++) {
      if (lowerCandidate[ci] === lowerQuery[qi]) {
        qi++;
        score += 1;
      }
    }
    if (qi === lowerQuery.length) {
      return { match: true, score };
    }
    return { match: false, score: 0 };
  }

  private updateResults(): void {
    if (this.query.length === 0) {
      this.results = this.allFiles;
      return;
    }

    const found = this.searchHits?.query === this.query ? this.searchHits.files.filter(file => !this.allFiles.includes(file)) : [];
    const scored = [...this.allFiles, ...found]
      .map(f => ({ file: f, ...this.fuzzyMatch(this.query, f) }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      ;

    this.results = scored.map(r => r.file);
    if (this.selectedIndex >= this.results.length) {
      this.selectedIndex = Math.max(0, this.results.length - 1);
    }
  }

  private async loadFiles(root: string, assertCurrent: () => void): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    const limit = { truncated: false };
    await this.walkDir(root, root, files, 0, assertCurrent, limit);
    assertCurrent();
    return { files: files.sort(), truncated: limit.truncated };
  }

  private async walkDir(
    root: string, dir: string, files: string[], depth: number, assertCurrent: () => void, limit: { truncated: boolean },
  ): Promise<void> {
    assertCurrent();
    if (depth > LIST_DEPTH_LIMIT || files.length > LIST_ENTRY_LIMIT) {
      limit.truncated = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }

    assertCurrent();
    // The same fixed exclusions the find and grep walks use, so the picker lists what they search.
    const visible = entries.filter(entry => !entry.name.startsWith('.'));
    for (const entry of visible) {
      assertCurrent();
      if (entry.isDirectory() && WALK_SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      if (entry.isDirectory()) {
        files.push(relPath + '/');
        await this.walkDir(root, fullPath, files, depth + 1, assertCurrent, limit);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  /** Invalidate the file cache (e.g., after file operations). */
  invalidateCache(): void {
    this.loading?.abort();
    this.loading = undefined;
    this.cachedRoot = undefined;
    this.loadError = undefined;
    this.filesCached = false;
    this.allFiles = [];
    this.results = [];
    this.selectedIndex = 0;
    // An open picker would otherwise sit empty with nothing loading.
    if (this.active) {
      this.startLoad();
      this.onUpdate?.();
    }
  }
}
