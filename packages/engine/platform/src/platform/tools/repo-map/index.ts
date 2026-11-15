import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { assertCapturedInputPathContext } from '../../contract/input-authority.js';
// Model-invoked repository map. Symbol detail is ranked by import-graph
// centrality and fits a default token budget, saying how many files it left
// out and how to see them. Structure detail discovers paths without reading
// source bodies: directories with counts first, file names for a requested
// path or a small project.
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, sep, relative, resolve } from 'node:path';
import type { Tool, ToolDefinition, ToolResult } from '../../types/tools.js';
import { ImportGraph } from '../../intelligence/index.js';
import { discoverProjectSourceFiles, projectImportGraph } from '../../intelligence/import-graph.js';
import { estimateTokens } from '../../core/compaction-types.js';
import { summarizeError } from '../../utils/error-display.js';
import { accessRestrictedNote, partitionByReadAccess, type ReadAccessFilter } from '../shared/read-access.js';

/** Ranked files whose read access is asked together. */
const READ_ACCESS_WINDOW = 16;
/** The symbol map's default size: the read class's ceiling, so the default answer fits what a model can take. */
export const DEFAULT_REPO_MAP_BUDGET_TOKENS = 25_000;
/** Up to this many paths, structure detail lists every file; past it, directories with counts unless a path is asked for. */
export const STRUCTURE_FILE_LISTING_LIMIT = 400;


interface RankedFile {
  readonly rel: string;
  readonly dependents: number;
  readonly bytes: number;
}

/**
 * Extract top-level exported names from source text with a cheap regex. Handles
 * `export const/let/var/function/class/interface/type/enum` (incl. `async`,
 * `default`, `abstract class`) and named re-exports `export { a, b as c }`.
 * Deliberately shallow: this is a map, not a parser.
 */
export function extractTopLevelExports(source: string): string[] {
  const names = new Set<string>();
  const declRe = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    if (m[1]) names.add(m[1]);
  }
  const namedRe = /^\s*export\s*\{([^}]*)\}/gm;
  while ((m = namedRe.exec(source)) !== null) {
    for (const part of (m[1] ?? '').split(',')) {
      const token = part.trim();
      if (!token) continue;
      const asMatch = /\sas\s+([A-Za-z_$][\w$]*)/.exec(token);
      const name = asMatch ? asMatch[1]! : token.split(/\s+/)[0]!;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/^\s*export\s+default\b(?!\s+(?:async\s+)?(?:abstract\s+)?(?:function|class))/m.test(source)) {
    names.add('default');
  }
  return [...names];
}

/** Rank the graph's files by centrality (dependents), then size, then path. */
function rankFiles(relGraph: Record<string, string[]>, root: string): RankedFile[] {
  // Invert the forward import map into a dependent count per file.
  const dependents = new Map<string, number>();
  for (const file of Object.keys(relGraph)) dependents.set(file, 0);
  for (const imports of Object.values(relGraph)) {
    for (const imported of imports) {
      dependents.set(imported, (dependents.get(imported) ?? 0) + 1);
    }
  }
  const ranked: RankedFile[] = [];
  for (const rel of Object.keys(relGraph)) {
    let bytes = 0;
    try { bytes = statSync(resolve(root, rel)).size; } catch { bytes = 0; }
    ranked.push({ rel, dependents: dependents.get(rel) ?? 0, bytes });
  }
  ranked.sort((a, b) =>
    b.dependents - a.dependents ||
    b.bytes - a.bytes ||
    a.rel.localeCompare(b.rel),
  );
  return ranked;
}

/** Summarize files per immediate top-level directory (or '.' for root files). */
function directorySummary(files: readonly RankedFile[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = f.rel.includes(sep) ? f.rel.split(sep)[0]! : '.';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir, n]) => `  ${dir}/  (${n} source file${n === 1 ? '' : 's'})`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** The symbol budget: omitted means the default, 0 means no limit (every file), anything else is that many tokens. */
function requestedBudget(raw: unknown): number | undefined {
  if (raw === 0) return undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REPO_MAP_BUDGET_TOKENS;
}

/** Directories (recursive) with their source-file counts, largest subtree order kept stable by path. */
export function formatDirectoryCounts(root: string, files: readonly string[], warnings: readonly string[] = []): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const path = relative(root, file).split(sep).join('/');
    const parts = path.split('/').slice(0, -1);
    counts.set('.', (counts.get('.') ?? 0) + 1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/');
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  const lines = [
    '# Repository structure',
    `${files.length} source file(s) in ${counts.size - (counts.has('.') ? 1 : 0)} director${counts.size === 2 ? 'y' : 'ies'}. Each row is [directory, source files under it, including subdirectories].`,
    `File names are listed for a project of up to ${STRUCTURE_FILE_LISTING_LIMIT} files; for this one, call repo_map with detail="structure" and path=<directory> to list a directory's files.`,
    '',
    ...[...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([directory, count]) => JSON.stringify([directory, count])),
  ];
  if (warnings.length) lines.push('', 'Discovery warnings:', ...warnings);
  return lines.join('\n');
}

/** Every path is reconstructible from its directory and exact JSON basename. */
export function formatRepositoryStructure(root: string, files: readonly string[], warnings: readonly string[] = []): string {
  const directories = new Map<string, string[]>();
  for (const file of files) {
    const path = relative(root, file).split(sep).join('/');
    const slash = path.lastIndexOf('/');
    const directory = slash < 0 ? '.' : path.slice(0, slash);
    const names = directories.get(directory) ?? [];
    names.push(path.slice(slash + 1));
    directories.set(directory, names);
  }
  const lines = [
    '# Repository structure',
    `${files.length} source file(s). Complete path listing; no source bodies, exported symbols or import graph read.`,
    'Each row is [directory, exact basenames]; join each basename to its directory to recover every path. Directory "." means the requested root.',
    'Path discovery does not establish content read permission or completed review. Use read tools for source contents and symbols.',
    '',
    ...[...directories.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([directory, names]) => JSON.stringify([directory, names.sort()])),
  ];
  if (warnings.length) lines.push('', 'Discovery warnings:', ...warnings);
  return lines.join('\n');
}

const REPO_MAP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Subdirectory to map, relative to the project root (default: the whole project).',
    },
    budgetTokens: {
      type: 'number',
      description: `Approximate token budget for symbol detail. Default ${DEFAULT_REPO_MAP_BUDGET_TOKENS}; the map says how many files it left out. 0 includes every indexed source file and its exported symbols.`,
    },
    detail: {
      type: 'string',
      enum: ['symbols', 'structure'],
      description: `Default symbols: files ranked by how many others import them, with exported symbols, within the budget. Structure lists directories with source-file counts without reading source bodies (every file name for a path, or a project of up to ${STRUCTURE_FILE_LISTING_LIMIT} files); use it for initial orientation.`,
    },
  },
  additionalProperties: false,
};

/**
 * Build the repo_map tool bound to a project root. The tool is read-only and
 * safe to run in parallel.
 */
export function createRepoMapTool(options: {
  projectRoot: string;
  /**
   * Per-file read-permission decision (wired to PermissionManager.readAccess).
   * A restricted file keeps its ranked path line but its exported symbols, which
   * require reading the file, are withheld and the line is flagged.
   */
  readAccessFilter?: ReadAccessFilter;
  capturedReadAccess?: ReadAccessFilter;
  allowOutsideProject?: () => boolean;
}): Tool {
  const projectRoot = options.projectRoot;
  const readAccessFilter = options.readAccessFilter;
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createRepoMapTool requires projectRoot');
  }

  const definition: ToolDefinition = {
    name: 'repo_map',
    description:
      'Return a map of the repository: a per-directory source-file count plus the most central '
      + 'source files (ranked by how many other files import them, size as a '
      + `tie-break) with their top-level exported symbols, within about ${DEFAULT_REPO_MAP_BUDGET_TOKENS} tokens by default; it says how many files it left out. Call this to orient in an unfamiliar `
      + 'codebase before reading files; narrow it with path. Use detail="structure" for directories and source paths without reading bodies or building an import graph. Read-only; covers TypeScript/JavaScript source files.',
    parameters: REPO_MAP_SCHEMA,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    try {
      const budgetTokens = requestedBudget(args['budgetTokens']);
      const rawPath = typeof args['path'] === 'string' ? args['path'].trim() : '';
      const requested = rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath)) : projectRoot;
      const outsideProjectAllowed = options.allowOutsideProject?.() ?? false;
      const root = resolveAndValidatePath(requested, projectRoot, outsideProjectAllowed);

      const assertModeCurrent = () => {
        if ((options.allowOutsideProject?.() ?? false) !== outsideProjectAllowed) throw new Error('Map permission mode changed');
      };
      if (args['detail'] === 'structure') {
        // Names are discovery, never a content authorization or source-read receipt.
        // Use the same traversal and captured-input fences as the symbol map.
        assertCapturedInputPathContext(root);
        const discovered = await discoverProjectSourceFiles(root);
        assertModeCurrent();
        assertCapturedInputPathContext(root);
        const listFiles = rawPath.length > 0 || discovered.files.length <= STRUCTURE_FILE_LISTING_LIMIT;
        return { success: true, output: listFiles
          ? formatRepositoryStructure(root, discovered.files, discovered.warnings)
          : formatDirectoryCounts(root, discovered.files, discovered.warnings) };
      }
      // A captured view builds its own graph through its read access; every other caller reads the one
      // graph per root that edit and find share.
      let graph: ImportGraph;
      if (options.capturedReadAccess) {
        graph = new ImportGraph();
        await graph.build(root, options.capturedReadAccess);
      } else {
        graph = await projectImportGraph(root);
      }
      assertModeCurrent();
      const relGraph = graph.toRelativeGraph(root);
      const stats = graph.stats();
      const ranked = rankFiles(relGraph, root);

      const header = [
        `# Repository map: ${relative(projectRoot, root) || '.'}`,
        `${stats.files} source file(s), ${stats.edges} import edge(s).${budgetTokens === undefined ? ' No budget: every file.' : ` Budget: ${budgetTokens} tokens.`}`,
        '',
        'Directories:',
        ...directorySummary(ranked),
        '',
        'Key files (by import centrality):',
      ].join('\n');

      let output = header;
      let included = 0;
      let restrictedCount = 0;
      let unreadableCount = 0;
      // Read access is asked a window of ranked files at a time (bounded
      // concurrency), continuing through all files unless a budget was requested.
      const restrictedFiles = new Set<string>();
      let asked = 0;
      let full = false;
      for (let index = 0; index < ranked.length && !full; index++) {
        assertModeCurrent();
        const file = ranked[index]!;
        if (index >= asked) {
          const window = ranked.slice(asked, asked + READ_ACCESS_WINDOW);
          for (const restricted of (await partitionByReadAccess(window, (entry) => resolve(root, entry.rel), readAccessFilter)).restricted) {
            restrictedFiles.add(restricted.rel);
          }
          asked += window.length;
        }
        const absolute = resolve(root, file.rel);
        let block: string;
        if (!restrictedFiles.has(file.rel) && options.capturedReadAccess) {
          // A denial, or a filter that cannot answer, withholds the symbols exactly like a live restriction.
          let allowed = false;
          try { allowed = await options.capturedReadAccess(absolute); } catch { allowed = false; }
          if (!allowed) restrictedFiles.add(file.rel);
        }
        if (restrictedFiles.has(file.rel)) {
          // Read-side deny enforcement: keep the ranked path (existence is not a
          // leak) but withhold the exported symbols, which would require reading
          // the file's content.
          block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)}) [access-restricted]`;
        } else {
          try {
            assertCapturedInputPathContext(absolute);
            const exports = extractTopLevelExports(await readFile(absolute, 'utf-8'));
            const exportsLine = exports.length > 0 ? `\n    exports: ${exports.join(', ')}` : '';
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)})${exportsLine}`;
          } catch {
            // Not the same as "no exports": say that the file could not be read.
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)}) [unreadable]`;
            unreadableCount++;
          }
        }
        if (budgetTokens !== undefined && estimateTokens(output + block) > budgetTokens) {
          full = true;
          break;
        }
        if (restrictedFiles.has(file.rel)) restrictedCount++;
        output += block;
        included++;
      }

      if (included < ranked.length) {
        output += `\n  … ${ranked.length - included} more file(s) left out to stay within the ${budgetTokens ?? 0}-token budget. `
          + 'See them by mapping a subdirectory (path), raising budgetTokens, or detail="structure".';
      }

      assertModeCurrent();
      const restrictedNote = accessRestrictedNote(restrictedCount);
      if (restrictedNote) output += `\n\n${restrictedNote} (paths shown, exported symbols withheld).`;
      if (unreadableCount > 0) output += `\n\n${unreadableCount} file(s) could not be read (paths shown, exported symbols missing).`;
      // The graph notes what it skipped; a map built without them would read as complete.
      const warnings = graph.getWarnings();
      if (warnings.length > 0) output += `\n\nDiscovery warnings (the map lacks these parts):\n${warnings.join('\n')}`;

      return { success: true, output };
    } catch (err) {
      return { success: false, error: `repo_map failed: ${summarizeError(err)}` };
    }
  }

  return { definition, execute };
}
