import { copyFileSync, realpathSync, renameSync, unlinkSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname, basename, extname, sep } from 'node:path';
import { logger } from '../../utils/logger.js';
import { resolveAndValidatePath, resolveWritablePath } from '../../utils/path-safety.js';
import type { ExecFileOp } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';

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

/**
 * The specifier an importer should use after `oldSrc` moved to `newDst`, or null
 * when `specifier` (resolved from `importerDir`) does not name `oldSrc`. The
 * spelling the importer used is kept: an explicit extension (./x.js, the NodeNext
 * convention), no extension, or a directory index.
 */
function rewrittenSpecifier(specifier: string, importerDir: string, oldSrc: string, newDst: string): string | null {
  const target = resolve(importerDir, specifier);
  const oldBare = withoutExt(oldSrc);
  if (target === oldSrc || withoutExt(target) === oldBare) {
    const ext = TS_EXTS.has(extname(specifier)) ? extname(specifier) : '';
    return relativeSpecifier(importerDir, withoutExt(newDst)) + ext;
  }
  if (target === dirname(oldSrc) && basename(oldBare) === 'index') {
    return relativeSpecifier(importerDir, basename(withoutExt(newDst)) === 'index' ? dirname(newDst) : withoutExt(newDst));
  }
  return null;
}

async function updateImportsAfterMove(
  oldSrc: string,
  newDst: string,
  projectRoot: string,
): Promise<{ updated: string[]; warnings: string[] }> {
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);
  const allFiles: string[] = [];
  const warnings: string[] = [];

  function walkDir(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      warnings.push(`Import update could not read directory '${dir}': ${summarizeError(error)}`);
      logger.warn('file move import update: failed to read directory', {
        dir,
        error: summarizeError(error),
      });
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) { walkDir(full); continue; }
        if (TS_EXTS.has(extname(full))) allFiles.push(full);
      } catch (error) {
        warnings.push(`Import update could not stat '${full}': ${summarizeError(error)}`);
        logger.warn('file move import update: failed to stat path', {
          path: full,
          error: summarizeError(error),
        });
      }
    }
  }
  walkDir(projectRoot);
  if (!allFiles.includes(newDst) && TS_EXTS.has(extname(newDst))) allFiles.push(newDst);

  const updated: string[] = [];
  for (const file of allFiles) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (error) {
      warnings.push(`Import update could not read '${file}': ${summarizeError(error)}`);
      logger.warn('file move import update: failed to read file', {
        file,
        error: summarizeError(error),
      });
      continue;
    }

    const isMovedFile = file === newDst;
    const newContent = content.replace(SPECIFIER_RE, (match, lead: string, quote: string, specifier: string) => {
      // The moved file's own relative imports were written for its old directory.
      const next = isMovedFile
        ? (dirname(oldSrc) === dirname(newDst) ? null : relativeSpecifier(dirname(newDst), resolve(dirname(oldSrc), specifier)))
        : rewrittenSpecifier(specifier, dirname(file), oldSrc, newDst);
      return next === null || next === specifier ? match : `${lead}${quote}${next}${quote}`;
    });

    if (newContent !== content) {
      try {
        writeFileSync(file, newContent, 'utf-8');
        updated.push(file);
      } catch (err) {
        warnings.push(`Import update could not write '${file}': ${summarizeError(err)}`);
        logger.warn('exec file_ops update_imports: write failed', {
          file,
          error: summarizeError(err),
        });
      }
    }
  }

  if (updated.length === 0 && warnings.length === 0 && TS_EXTS.has(extname(oldSrc))) {
    warnings.push(`update_imports changed nothing after moving '${oldSrc}': no importer or relative import of the moved file needed a new path. If imports are written another way (aliases, non-relative paths), update them yourself.`);
  }
  return { updated, warnings };
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

  for (const { src, dst } of pendingImportUpdates) {
    if (access) await access.beforeImportUpdates();
    assertCurrent?.();
    const matchingResult = fileOpResults.find((r) => r.source === src && r.destination === dst);
    try {
      const updateResult = await updateImportsAfterMove(src, dst, projectRoot);
      if (matchingResult) {
        matchingResult.updated_imports = updateResult.updated;
        for (const warning of updateResult.warnings) {
          appendFileOpWarning(matchingResult, warning);
        }
      }
      fileOpWarnings.push(...updateResult.warnings);
    } catch (err) {
      const warning = `file_ops update_imports failed after moving '${src}' to '${dst}': ${summarizeError(err)}`;
      if (matchingResult) {
        appendFileOpWarning(matchingResult, warning);
      }
      fileOpWarnings.push(warning);
      logger.warn('exec file_ops: update_imports failed', {
        src,
        dst,
        error: summarizeError(err),
      });
    }
  }

  return {
    fileOpResults,
    ...(fileOpError !== undefined ? { fileOpError, fileOpFailedIndex } : {}),
    ...(fileOpWarnings.length > 0 ? { fileOpWarnings } : {}),
  };
}
