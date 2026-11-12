import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { assertCapturedInputPathContext } from '../../contract/input-authority.js';
// Model-invoked repository map. Every indexed source file and export is
// included by default; a caller can explicitly request a smaller token budget.
// Structure detail discovers complete paths without reading source bodies.
// Import-graph centrality determines ordering in symbol detail only.
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, sep, relative, resolve } from 'node:path';
import type { Tool, ToolDefinition, ToolResult } from '../../types/tools.js';
import { ImportGraph } from '../../intelligence/index.js';
import { discoverProjectSourceFiles } from '../../intelligence/import-graph.js';
import { estimateTokens } from '../../core/compaction-types.js';
import { summarizeError } from '../../utils/error-display.js';
import { accessRestrictedNote, partitionByReadAccess, type ReadAccessFilter } from '../shared/read-access.js';

/** Ranked files whose read access is asked together. */
const READ_ACCESS_WINDOW = 16;


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

function requestedBudget(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
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
      description: 'Optional approximate token budget for symbol detail. Omit or set 0 to include every indexed source file and its exported symbols. Structure detail always includes every discovered source path.',
    },
    detail: {
      type: 'string',
      enum: ['symbols', 'structure'],
      description: 'Default symbols includes the full ranked import graph and exported symbols. Structure lists all source paths grouped by directory without reading source bodies; use it for initial orientation.',
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
      'Return a map of the repository: a per-directory source-file count plus all indexed '
      + 'source files (ranked by how many other files import them, size as a '
      + 'tie-break) with their top-level exported symbols. Call this to orient in an unfamiliar '
      + 'codebase before reading files. Use detail="structure" for complete source paths without reading bodies or building an import graph. Read-only; covers TypeScript/JavaScript source files.',
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
        return { success: true, output: formatRepositoryStructure(root, discovered.files, discovered.warnings) };
      }
      const graph = new ImportGraph();
      await graph.build(root, options.capturedReadAccess);
      assertModeCurrent();
      const relGraph = graph.toRelativeGraph(root);
      const stats = graph.stats();
      const ranked = rankFiles(relGraph, root);

      const header = [
        `# Repository map: ${relative(projectRoot, root) || '.'}`,
        `${stats.files} source file(s), ${stats.edges} import edge(s).${budgetTokens === undefined ? '' : ` Requested budget: ${budgetTokens} tokens.`}`,
        '',
        'Directories:',
        ...directorySummary(ranked),
        '',
        'Key files (by import centrality):',
      ].join('\n');

      let output = header;
      let included = 0;
      let restrictedCount = 0;
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
        if (restrictedFiles.has(file.rel)) {
          // Read-side deny enforcement: keep the ranked path (existence is not a
          // leak) but withhold the exported symbols, which would require reading
          // the file's content.
          block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)}) [access-restricted]`;
        } else {
          try {
            if (options.capturedReadAccess && !await options.capturedReadAccess(absolute)) throw new Error('captured map path is access-restricted');
            assertCapturedInputPathContext(absolute);
            const exports = extractTopLevelExports(await readFile(absolute, 'utf-8'));
            const exportsLine = exports.length > 0 ? `\n    exports: ${exports.join(', ')}` : '';
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)})${exportsLine}`;
          } catch {
            block = `\n  ${file.rel}  (dependents: ${file.dependents}, ${formatBytes(file.bytes)})`;
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
        output += `\n  … ${ranked.length - included} more file(s) omitted to stay within the token budget.`;
      }

      assertModeCurrent();
      const restrictedNote = accessRestrictedNote(restrictedCount);
      if (restrictedNote) output += `\n\n${restrictedNote} (paths shown, exported symbols withheld).`;

      return { success: true, output };
    } catch (err) {
      return { success: false, error: `repo_map failed: ${summarizeError(err)}` };
    }
  }

  return { definition, execute };
}
