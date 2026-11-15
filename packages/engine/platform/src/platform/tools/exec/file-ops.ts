import { copyFileSync, realpathSync, renameSync, unlinkSync, rmSync, cpSync, existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname, basename, extname, sep } from 'node:path';
import { logger } from '../../utils/logger.js';
import { resolveAndValidatePath, resolveWritablePath } from '../../utils/path-safety.js';
import type { ExecFileOp } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import { walkDir } from '../../utils/walk-dir.js';

function lexists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export interface FileOpResult {
  op: string;
  source: string;
  destination?: string | undefined;
  dry_run?: boolean | undefined;
  would_delete?: string[] | undefined;
  updated_imports?: string[] | undefined;
  warnings?: string[] | undefined;
}

function appendFileOpWarning(result: FileOpResult, warning: string): void {
  result.warnings = [...(result.warnings ?? []), warning];
}

function resolveFileOpPath(p: string, projectRoot: string): string {
  // Absolute paths are held to the root as well: these operations run on the
  // host, outside any boundary, so the root is the only limit there is.
  return resolveWritablePath(p, projectRoot);
}

/** The root itself and the repository metadata are never deleted by a file operation. */
function assertDeletable(src: string, projectRoot: string): void {
  // Paths are built on the canonical root, so compare against it: a symlinked root would otherwise never match.
  // The parent is resolved too, so a link inside the project that aliases the root or a directory above .git cannot skip the check; the final name is left alone so deleting a link only removes the link.
  let parent = dirname(src);
  try { parent = realpathSync(parent); } catch { /* a missing parent has nothing to alias; the operation itself reports it */ }
  const rel = relative(realpathSync(resolve(projectRoot)), join(parent, basename(src)));
  if (rel === '') throw new Error(`file_ops delete: refusing to delete the project root '${projectRoot}'. Name the files or directories inside it.`);
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) throw new Error(`file_ops delete: refusing to delete inside '.git' ('${rel}').`);
}

function collectPaths(p: string, acc: string[] = [], warnings: string[] = []): string[] {
  try {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        collectPaths(join(p, entry), acc, warnings);
      }
    } else {
      acc.push(p);
    }
  } catch (err) {
    warnings.push(`Could not inspect '${p}' while collecting delete preview: ${summarizeError(err)}`);
    acc.push(p);
  }
  return acc;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SPECIFIER_RE = /(\b(?:from|import|require)\s*\(?\s*)(['"])(\.\.?(?:\/[^'"\n]*)?)\2/g;

const withoutExt = (path: string): string => (TS_EXTS.has(extname(path)) ? path.slice(0, -extname(path).length) : path);

/** A relative specifier for `target` as seen from `fromDir`, always starting with ./ or ../. */
function relativeSpecifier(fromDir: string, target: string): string {
  const rel = relative(fromDir, target).split(sep).join('/');
  if (rel === '') return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Directories an import rewrite never descends into, besides the walker's own skips (hidden entries, dependencies, product worktrees). */
const IMPORT_SCAN_SKIP_DIRS = new Set(['build', 'out', 'coverage']);

/** Where each moved source file went, keyed three ways an importer can name it. */
interface MoveMap {
  /** Old path without its TS/JS extension -> new path, and which move did it. */
  readonly byBare: Map<string, { readonly to: string; readonly move: number }>;
  /** Old directory whose index file moved -> the new index file. */
  readonly byIndexDir: Map<string, { readonly to: string; readonly move: number }>;
  /** New path of each moved file -> its old path and move. */
  readonly byNew: Map<string, { readonly from: string; readonly move: number }>;
}

async function sourceFilesUnder(path: string): Promise<string[]> {
  const st = statSync(path);
  if (!st.isDirectory()) return TS_EXTS.has(extname(path)) ? [path] : [];
  const files: string[] = [];
  for await (const file of walkDir(path, {
    selectFile: (candidate) => TS_EXTS.has(extname(candidate)),
    selectDirectory: (candidate) => (IMPORT_SCAN_SKIP_DIRS.has(basename(candidate)) ? false : undefined),
  })) files.push(file);
  return files;
}

/** Every moved source file, old path to new, for files moved alone and files under a moved directory. */
async function buildMoveMap(moves: readonly { readonly src: string; readonly dst: string }[]): Promise<MoveMap> {
  const map: MoveMap = { byBare: new Map(), byIndexDir: new Map(), byNew: new Map() };
  for (const [move, { src, dst }] of moves.entries()) {
    for (const to of await sourceFilesUnder(dst)) {
      const from = to === dst ? src : join(src, relative(dst, to));
      map.byBare.set(withoutExt(from), { to, move });
      if (basename(withoutExt(from)) === 'index') map.byIndexDir.set(dirname(from), { to, move });
      map.byNew.set(to, { from, move });
    }
  }
  return map;
}

/**
 * Where a specifier that resolved (from the old layout) to `target` points now,
 * spelled the way the importer spelled it: an explicit extension (./x.js, the
 * NodeNext convention), no extension, or a directory index. Null when `target`
 * names no moved file.
 */
function movedTarget(target: string, specifier: string, map: MoveMap): { readonly path: string; readonly move: number } | null {
  const file = map.byBare.get(withoutExt(target));
  if (file) return { path: withoutExt(file.to) + (TS_EXTS.has(extname(specifier)) ? extname(specifier) : ''), move: file.move };
  const index = map.byIndexDir.get(target);
  if (index) return { path: basename(withoutExt(index.to)) === 'index' ? dirname(index.to) : withoutExt(index.to), move: index.move };
  return null;
}

/**
 * Rewrite the imports a batch of moves broke, in one pass over the project:
 * every relative specifier that named a moved file now names its new place, and
 * every moved file's own relative imports are re-based on its new directory.
 * Files are read asynchronously; each changed file is written once.
 */
async function updateImportsAfterMoves(
  moves: readonly { readonly src: string; readonly dst: string }[],
  projectRoot: string,
): Promise<{ updated: Map<number, string[]>; warnings: string[]; sourcesMoved: Map<number, number> }> {
  const map = await buildMoveMap(moves);
  const updated = new Map<number, string[]>();
  const warnings: string[] = [];
  const sourcesMoved = new Map<number, number>();
  for (const { move } of map.byNew.values()) sourcesMoved.set(move, (sourcesMoved.get(move) ?? 0) + 1);
  const files = new Set<string>();
  for await (const file of walkDir(projectRoot, {
    selectFile: (candidate) => TS_EXTS.has(extname(candidate)),
    selectDirectory: (candidate) => (IMPORT_SCAN_SKIP_DIRS.has(basename(candidate)) ? false : undefined),
  })) files.add(file);
  for (const moved of map.byNew.keys()) files.add(moved);

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch (error) {
      warnings.push(`Import update could not read '${file}': ${summarizeError(error)}`);
      continue;
    }
    const self = map.byNew.get(file);
    // A moved file's specifiers were written for its old directory.
    const resolvedFrom = dirname(self?.from ?? file);
    const touched = new Set<number>();
    const newContent = content.replace(SPECIFIER_RE, (match, lead: string, quote: string, specifier: string) => {
      const target = resolve(resolvedFrom, specifier);
      const moved = movedTarget(target, specifier, map);
      let next: string | null = null;
      if (moved) {
        next = relativeSpecifier(dirname(file), moved.path);
        touched.add(moved.move);
      } else if (self && resolvedFrom !== dirname(file)) {
        next = relativeSpecifier(dirname(file), target);
        touched.add(self.move);
      }
      return next === null || next === specifier ? match : `${lead}${quote}${next}${quote}`;
    });
    if (newContent === content) continue;
    try {
      await writeFile(file, newContent, 'utf-8');
      for (const move of touched) updated.set(move, [...(updated.get(move) ?? []), file]);
    } catch (error) {
      warnings.push(`Import update could not write '${file}': ${summarizeError(error)}`);
      logger.warn('exec file_ops update_imports: write failed', { file, error: summarizeError(error) });
    }
  }
  return { updated, warnings, sourcesMoved };
}

export function executeFileOp(op: ExecFileOp, projectRoot: string): FileOpResult {
  // The root itself is named as such before the journal check, which would otherwise refuse '.' with a message about something else.
  if (op.op === 'delete') assertDeletable(resolveAndValidatePath(op.source, projectRoot), projectRoot);
  const src = resolveFileOpPath(op.source, projectRoot);
  const result: FileOpResult = { op: op.op, source: src };

  if (op.op === 'delete') {
    if (op.dry_run) {
      const warnings: string[] = [];
      result.dry_run = true;
      result.would_delete = collectPaths(src, [], warnings);
      if (warnings.length > 0) {
        result.warnings = warnings;
      }
      return result;
    }
    // A path that is not there is a mistyped path, not a deletion.
    if (!lexists(src)) throw new Error(`file_ops delete: nothing at '${op.source}'. Nothing was deleted; check the path.`);
    if (op.recursive) {
      rmSync(src, { recursive: true, force: true });
    } else {
      unlinkSync(src);
    }
    return result;
  }

  if (!op.destination) {
    throw new Error(`file_ops ${op.op} requires destination`);
  }
  const dst = resolveFileOpPath(op.destination, projectRoot);
  result.destination = dst;

  if (!op.overwrite && existsSync(dst)) {
    throw new Error(`file_ops ${op.op}: destination already exists: '${op.destination}'. Set overwrite: true to replace it.`);
  }

  if (op.op === 'copy') {
    if (op.recursive) {
      cpSync(src, dst, { recursive: true });
    } else {
      copyFileSync(src, dst);
    }
    return result;
  }

  if (op.op === 'move') {
    try {
      renameSync(src, dst);
    } catch (err) {
      appendFileOpWarning(
        result,
        `file_ops move used copy/delete fallback after rename failed from '${src}' to '${dst}': ${summarizeError(err)}`,
      );
      if (op.recursive) {
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      } else {
        copyFileSync(src, dst);
        unlinkSync(src);
      }
    }
  }

  return result;
}

export async function executeFileOperations(
  fileOps: ExecFileOp[] | undefined,
  projectRoot: string,
  access?: {
    beforeOperation: (op: ExecFileOp) => Promise<void>;
    beforeImportUpdates: () => Promise<void>;
  },
  assertCurrent?: () => void,
): Promise<{ fileOpResults: FileOpResult[]; fileOpError?: string; fileOpFailedIndex?: number | undefined; fileOpWarnings?: string[] }> {
  const fileOpResults: FileOpResult[] = [];
  const pendingImportUpdates: Array<{ src: string; dst: string }> = [];
  const fileOpWarnings: string[] = [];

  if (!fileOps || fileOps.length === 0) {
    return { fileOpResults };
  }

  let fileOpError: string | undefined;
  let fileOpFailedIndex: number | undefined;
  for (const [index, op] of fileOps.entries()) {
    // Boundary failures propagate to the owner of the disposable view. They
    // must not be downgraded into ordinary operation errors or import warnings.
    if (access) await access.beforeOperation(op);
    assertCurrent?.();
    try {
      const opResult = executeFileOp(op, projectRoot);
      fileOpResults.push(opResult);
      fileOpWarnings.push(...(opResult.warnings ?? []));
      if (op.op === 'move' && op.update_imports && opResult.destination) {
        pendingImportUpdates.push({ src: opResult.source, dst: opResult.destination });
      }
    } catch (err) {
      // Earlier operations stay applied; their import updates still run below so
      // the tree is not left half-moved with importers pointing at nothing.
      fileOpError = `file_ops failed: ${summarizeError(err)}`;
      fileOpFailedIndex = index;
      break;
    }
  }

  if (pendingImportUpdates.length > 0) {
    if (access) await access.beforeImportUpdates();
    assertCurrent?.();
    const moveResults = pendingImportUpdates.map(({ src, dst }) => fileOpResults.find((r) => r.source === src && r.destination === dst));
    try {
      const updateResult = await updateImportsAfterMoves(pendingImportUpdates, projectRoot);
      for (const [move, { src }] of pendingImportUpdates.entries()) {
        const matchingResult = moveResults[move];
        const updated = updateResult.updated.get(move) ?? [];
        if (matchingResult) matchingResult.updated_imports = updated;
        if (updated.length === 0 && updateResult.warnings.length === 0 && (updateResult.sourcesMoved.get(move) ?? 0) > 0) {
          const warning = `update_imports changed nothing after moving '${src}': no relative import of a moved file, and no relative import inside it, needed a new path. If imports are written another way (aliases, non-relative paths), update them yourself.`;
          if (matchingResult) appendFileOpWarning(matchingResult, warning);
          fileOpWarnings.push(warning);
        }
      }
      for (const warning of updateResult.warnings) {
        for (const matchingResult of moveResults) if (matchingResult) appendFileOpWarning(matchingResult, warning);
      }
      fileOpWarnings.push(...updateResult.warnings);
    } catch (err) {
      const warning = `file_ops update_imports failed after moving ${pendingImportUpdates.map(({ src, dst }) => `'${src}' to '${dst}'`).join(', ')}: ${summarizeError(err)}`;
      for (const matchingResult of moveResults) if (matchingResult) appendFileOpWarning(matchingResult, warning);
      fileOpWarnings.push(warning);
      logger.warn('exec file_ops: update_imports failed', { error: summarizeError(err) });
    }
  }

  return {
    fileOpResults,
    ...(fileOpError !== undefined ? { fileOpError, fileOpFailedIndex } : {}),
    ...(fileOpWarnings.length > 0 ? { fileOpWarnings } : {}),
  };
}
