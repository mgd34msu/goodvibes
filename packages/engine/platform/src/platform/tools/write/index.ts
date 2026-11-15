import { assertCurrentToolInvocation } from '../registry.js';
import { captureFileEffectRevision } from '../shared/file-effect-revision.js';
import type { CapturedWriteRevision } from '../shared/captured-write-revision.js';
import { assertCapturedToolWriteRevision, captureCapturedToolWriteRevision, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation, prepareCapturedToolBackup } from '../shared/captured-input-tools.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import { chmodSync, lstatSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import { WRITE_SCHEMA, WRITE_TEXT_ENCODINGS, type WriteInput, type WriteFileInput, type WriteMode } from './schema.js';
import { runValidators, formatValidatorFailure, type ValidatorName, type ValidatorRunner } from '../shared/validators.js';
import { FileStateCache } from '../../state/file-cache.js';
import { ProjectIndex } from '../../state/project-index.js';
import { FileUndoManager } from '../../state/file-undo.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { healToolFile, type CapturedAutoHealBackend } from '../shared/captured-auto-heal.js';
import { isNotebookFile } from '../../utils/notebook.js';
import { logger } from '../../utils/logger.js';
import type { SessionChangeTracker } from '../../sessions/change-tracker.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveWritablePath } from '../../utils/path-safety.js';
import { noteProjectFilesChanged } from '../../intelligence/project-files-epoch.js';
import { collectPostEditDiagnostics, type DiagnosticsProvider } from '../shared/post-edit-diagnostics.js';
import { ToolInputProjectionError } from '../input-projection.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface FileWriteResult {
  path: string;
  resolved_path: string;
  bytes_written: number;
  mode_applied: WriteMode;
  backup_path?: string | undefined;
  warnings?: string[] | undefined;
  auto_heal?: {
    attempted: boolean;
    healed: boolean;
    method?: 'formatter' | 'linter' | 'llm' | undefined;
  } | undefined;
  /** true if this was a dry-run entry */
  would_write?: boolean | undefined;
  /** decoded content, used internally to avoid double resolveContent call */
  _content?: string | undefined;
  /** The exact bytes written when the payload is not valid UTF-8 text; `_content` is then unset. */
  _bytes?: Buffer | undefined;
}

/** The topmost directory a write had to create, so a rolled-back new file can take its empty parents with it. */
const createdDirectories = new WeakMap<FileWriteResult, string>();

/** Remove the directories a rolled-back write created, innermost first; anything not empty stays. */
function removeCreatedDirectories(written: FileWriteResult): void {
  const top = createdDirectories.get(written);
  if (top === undefined) return;
  for (let directory = dirname(written.resolved_path); directory === top || directory.startsWith(`${top}${sep}`); directory = dirname(directory)) {
    try { rmdirSync(directory); } catch { return; }
    if (directory === top) return;
  }
}

interface WriteOutput {
  files_written: number;
  bytes_written: number;
  files?: FileWriteResult[] | undefined;
  dry_run?: boolean | undefined;
  warnings?: string[] | undefined;
}

function appendWarning(
  warnings: string[],
  warning: string,
  fileResult?: FileWriteResult | undefined,
): void {
  warnings.push(warning);
  if (fileResult) {
    fileResult.warnings = [...(fileResult.warnings ?? []), warning];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What a file entry writes: text, or exact bytes when a base64 payload is not valid UTF-8 text. */
type ResolvedContent = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'bytes'; readonly bytes: Buffer };

/**
 * Decode content from either the raw string or base64 field. A base64 payload
 * that round-trips as UTF-8 is text; anything else is kept as bytes, because
 * decoding it as text would replace the invalid sequences and corrupt the file.
 */
function resolveContent(fileInput: WriteFileInput): ResolvedContent {
  if (fileInput.content_base64 !== undefined) {
    const bytes = Buffer.from(fileInput.content_base64, 'base64');
    const text = bytes.toString('utf-8');
    return Buffer.from(text, 'utf-8').equals(bytes) ? { kind: 'text', text } : { kind: 'bytes', bytes };
  }
  return { kind: 'text', text: fileInput.content ?? '' };
}

/**
 * Build a backup destination path inside .goodvibes/.backups/.
 * e.g. src/foo.ts -> <projectRoot>/.goodvibes/.backups/src/foo.ts.1700000000000
 */
function buildBackupPath(resolvedPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, resolvedPath);
  return join(projectRoot, '.goodvibes', '.backups', `${rel}.${Date.now()}`);
}

/** Module-level constant, avoids re-allocating the Set on every validation call. */
const VALID_CELL_TYPES = new Set(['code', 'markdown', 'raw']);

/**
 * Validate that a string contains well-formed Jupyter notebook JSON.
 * Checks required top-level fields and per-cell structure.
 * On success, returns the parsed notebook object to avoid a redundant JSON.parse at the call site.
 */
function validateNotebookContent(
  content: string,
): { valid: true; notebook: Record<string, unknown> } | { valid: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${summarizeError(err)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Notebook must be a JSON object' };
  }

  const nb = parsed as Record<string, unknown>;

  if (!('nbformat' in nb) || typeof nb['nbformat'] !== 'number') {
    return { valid: false, error: "Notebook must have a numeric 'nbformat' field" };
  }

  if (!('cells' in nb) || !Array.isArray(nb['cells'])) {
    return { valid: false, error: "Notebook must have a 'cells' array" };
  }

  for (let i = 0; i < (nb['cells'] as unknown[]).length; i++) {
    const cell = (nb['cells'] as unknown[])[i];
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
      return { valid: false, error: `Cell ${i} must be an object` };
    }
    const c = cell as Record<string, unknown>;

    if (!('cell_type' in c) || !VALID_CELL_TYPES.has(c['cell_type'] as string)) {
      return { valid: false, error: `Cell ${i} has missing or invalid 'cell_type' (must be 'code', 'markdown', or 'raw')` };
    }

    if (!('source' in c) || (typeof c['source'] !== 'string' && !Array.isArray(c['source']))) {
      return { valid: false, error: `Cell ${i} must have a 'source' field (string or array)` };
    }

    if (c['cell_type'] === 'code') {
      if ('outputs' in c && !Array.isArray(c['outputs'])) {
        return { valid: false, error: `Cell ${i} 'outputs' must be an array` };
      }
      if ('execution_count' in c && c['execution_count'] !== null && typeof c['execution_count'] !== 'number') {
        return { valid: false, error: `Cell ${i} 'execution_count' must be a number or null` };
      }
    }
  }

  return { valid: true, notebook: nb };
}

const MAX_LINK_HOPS = 40;

/** The path a write to `path` really lands on: each symbolic link is followed to what it points at. */
function followLinks(path: string): string {
  let current = path;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops += 1) {
    let isLink = false;
    try { isLink = lstatSync(current).isSymbolicLink(); } catch { return current; }
    if (!isLink) return current;
    current = resolvePath(dirname(current), readlinkSync(current));
  }
  throw new Error(`Too many levels of symbolic links at '${path}'`);
}

/**
 * Atomically write content to a file.
 * Writes to a temp file first, then renames to the target path.
 */
function atomicWrite(requestedPath: string, content: string | Buffer, encoding: BufferEncoding = 'utf-8'): void {
  // A symbolic link is written through: replacing the link itself with a regular file
  // would drop the link and give the new file the link's 0777 mode.
  const targetPath = followLinks(requestedPath);
  const rand = randomBytes(4).toString('hex');
  const tmpPath = `${targetPath}.tmp.${rand}`;
  try {
    const mode = existsSync(targetPath) ? lstatSync(targetPath).mode & 0o777 : 0o666 & ~process.umask();
    // Keep the temporary inode private until all bytes have been written.
    writeFileSync(tmpPath, content, { encoding, flag: 'wx', mode: 0o600 });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
    noteProjectFilesChanged();
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupErr) {
      throw new Error(
        `Atomic write failed for '${targetPath}': ${summarizeError(err)}. `
        + `Failed to remove temporary file '${tmpPath}': ${summarizeError(cleanupErr)}`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core write logic
// ---------------------------------------------------------------------------

/**
 * Process a single file write entry.
 * Returns null if successful (mutates results array) or a string error message.
 */
function processSingleWrite(
  fileInput: WriteFileInput,
  projectRoot: string,
  dryRun: boolean,
  capturedBackup?: Awaited<ReturnType<typeof prepareCapturedToolBackup>>,
  sourceRevision?: CapturedWriteRevision,
  assertCurrent: () => void = () => {},
): { ok: true; result: FileWriteResult } | { ok: false; error: string } {
  // Resolve and validate path
  let resolvedPath: string;
  try {
    resolvedPath = resolveWritablePath(fileInput.path, projectRoot);
  } catch (err) {
    return { ok: false, error: `Path error for '${fileInput.path}': ${summarizeError(err)}` };
  }

  const mode: WriteMode = fileInput.mode ?? 'fail_if_exists';

  // content is text and content_base64 is bytes; sending neither would truncate the file and sending both is ambiguous.
  if (fileInput.content === undefined && fileInput.content_base64 === undefined) {
    return { ok: false, error: `No content for '${fileInput.path}': provide content (text, an empty string is allowed) or content_base64. Nothing was written.` };
  }
  if (fileInput.content !== undefined && fileInput.content_base64 !== undefined) {
    return { ok: false, error: `Both content and content_base64 were given for '${fileInput.path}': provide exactly one. Nothing was written.` };
  }

  // Validate encoding
  const textEncodings: readonly string[] = WRITE_TEXT_ENCODINGS;
  if (fileInput.encoding && !textEncodings.includes(fileInput.encoding)) {
    return {
      ok: false,
      error: fileInput.encoding === 'hex' || fileInput.encoding === 'base64'
        ? `Encoding '${fileInput.encoding}' cannot be used with content: content is text. Send bytes as content_base64. Nothing was written.`
        : `Invalid encoding: '${fileInput.encoding}'. Valid: ${textEncodings.join(', ')}`,
    };
  }
  if (fileInput.content_base64 !== undefined && fileInput.encoding && fileInput.encoding !== 'utf-8' && fileInput.encoding !== 'utf8') {
    return { ok: false, error: `encoding '${fileInput.encoding}' does not apply to content_base64, which is written as the decoded bytes; omit it.` };
  }
  const encoding: BufferEncoding = (fileInput.encoding as BufferEncoding) ?? 'utf-8';

  // Validate base64 input
  if (fileInput.content_base64 !== undefined) {
    const b64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!b64Regex.test(fileInput.content_base64.replace(/\s/g, ''))) {
      return {
        ok: false,
        error: `Invalid base64 content for '${fileInput.path}': content is not valid base64.`,
      };
    }
  }

  const resolvedContent = resolveContent(fileInput);
  let content = resolvedContent.kind === 'text' ? resolvedContent.text : '';
  // A narrow text encoding re-encodes each character; one it cannot hold would be written as something else.
  if (resolvedContent.kind === 'text' && fileInput.content !== undefined && encoding !== 'utf-8' && encoding !== 'utf8'
    && Buffer.from(content, encoding).toString(encoding) !== content) {
    return { ok: false, error: `The text for '${fileInput.path}' has characters that encoding '${encoding}' cannot hold; use utf-8. Nothing was written.` };
  }

  // Notebook validation and normalization
  if (isNotebookFile(resolvedPath)) {
    const validation = validateNotebookContent(content);
    if (!validation.valid) {
      return {
        ok: false,
        error: `Invalid notebook content for '${fileInput.path}': ${validation.error}`,
      };
    }
    // Re-serialize with consistent formatting (1-space indent, trailing newline).
    // Use the already-parsed notebook from the validator to avoid a redundant JSON.parse.
    content = JSON.stringify(validation.notebook, null, 1) + '\n';
  }

  const byteSize = resolvedContent.kind === 'bytes' ? resolvedContent.bytes.length : Buffer.byteLength(content, encoding);

  const alreadyExists = existsSync(resolvedPath);

  if (alreadyExists && mode === 'fail_if_exists') {
    return {
      ok: false,
      error: `File already exists: '${fileInput.path}'. Use mode 'overwrite' or 'backup' to replace it.`,
    };
  }

  const result: FileWriteResult = {
    path: fileInput.path,
    resolved_path: resolvedPath,
    bytes_written: byteSize,
    mode_applied: mode,
    ...(resolvedContent.kind === 'bytes' ? { _bytes: resolvedContent.bytes } : { _content: content }),
  };

  if (dryRun) {
    result.would_write = true;
    if (alreadyExists && mode === 'backup') {
      result.backup_path = capturedBackup?.path ?? buildBackupPath(resolvedPath, projectRoot);
    }
    return { ok: true, result };
  }

  // Backup if needed
  if (alreadyExists && mode === 'backup') {
    if (hasCapturedToolInvocation() && !capturedBackup) return { ok: false, error: 'Captured backup requires its prepared owned destination' };
    const backupPath = capturedBackup?.path ?? buildBackupPath(resolvedPath, projectRoot);
    try {
      assertCurrent();
      if (capturedBackup) capturedBackup.create(sourceRevision);
      else {
        mkdirSync(dirname(backupPath), { recursive: true });
        assertCurrent();
        copyFileSync(resolvedPath, backupPath);
      }
      result.backup_path = backupPath;
    } catch (err) {
      return {
        ok: false,
        error: `Backup failed for '${fileInput.path}': ${summarizeError(err)}`,
      };
    }
  }

  // Auto-create parent directories
  try {
    assertCurrent();
    const created = mkdirSync(dirname(resolvedPath), { recursive: true });
    if (created !== undefined) createdDirectories.set(result, created);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create parent directories for '${fileInput.path}': ${summarizeError(err)}`,
    };
  }

  // Atomic write
  try {
    assertCurrent();
    atomicWrite(resolvedPath, resolvedContent.kind === 'bytes' ? resolvedContent.bytes : content, encoding);
  } catch (err) {
    return {
      ok: false,
      error: `Write failed for '${fileInput.path}': ${summarizeError(err)}`,
    };
  }

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Format output
// ---------------------------------------------------------------------------

/**
 * Adds the files a non-atomic batch already wrote to an error that ends the
 * batch early. The error object itself keeps its identity and class, since
 * callers classify terminal failures by them; abort reasons and frozen errors
 * are left untouched.
 */
function annotateWrittenFiles(error: unknown, results: FileWriteResult[], transactionMode: string): void {
  if (transactionMode === 'atomic' || !(error instanceof Error) || error instanceof DOMException) return;
  if (error instanceof ToolInputProjectionError) return;
  const written = results.filter((result) => !result.would_write).map((result) => result.path);
  if (written.length === 0) return;
  try {
    error.message += `. Files already written by this call before it stopped: ${written.join(', ')}`;
  } catch {
    // Frozen errors keep their original message.
  }
}

function formatOutput(
  results: FileWriteResult[],
  errors: string[],
  verbosity: string,
  dryRun: boolean,
): WriteOutput {
  const totalBytes = results.reduce((acc, r) => acc + r.bytes_written, 0);
  const base: WriteOutput = {
    files_written: results.length,
    bytes_written: totalBytes,
  };

  if (dryRun) {
    base.dry_run = true;
  }

  if (verbosity === 'count_only') {
    return base;
  }

  if (verbosity === 'minimal') {
    base.files = results.map(({ _content: _, _bytes: __, ...r }) => ({
      path: r.path,
      resolved_path: r.resolved_path,
      bytes_written: r.bytes_written,
      mode_applied: r.mode_applied,
      ...(r.backup_path ? { backup_path: r.backup_path } : {}),
      ...(r.would_write ? { would_write: r.would_write } : {}),
      ...(r.auto_heal ? { auto_heal: r.auto_heal } : {}),
      ...(r.warnings ? { warnings: r.warnings } : {}),
    }));
    return base;
  }

  // standard and verbose both include full results (strip internal _content field)
  base.files = results.map(({ _content: _, _bytes: __, ...r }) => r);
  return base;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWriteTool(options?: {
  projectRoot: string;
  fileCache?: FileStateCache | undefined;
  projectIndex?: ProjectIndex | undefined;
  fileUndoManager?: FileUndoManager | undefined;
  configManager?: Pick<ConfigManager, 'get'> | undefined;
  toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
  diagnosticsProvider?: DiagnosticsProvider | undefined;
  capturedReadAccess?: ReadAccessFilter | undefined;
  validatorRunner?: ValidatorRunner | undefined;
  capturedAutoHeal?: CapturedAutoHealBackend | undefined;
}): Tool {
  if (typeof options?.projectRoot !== 'string' || options.projectRoot.trim().length === 0) {
    throw new Error('createWriteTool requires projectRoot');
  }
  const projectRoot = options.projectRoot;
  const definition: ToolDefinition = {
    name: 'write',
    description:
      'Write one or more files to disk. Supports batch writes, automatic parent directory creation, ' +
      'and three overwrite modes: fail_if_exists (default), overwrite, backup. ' +
      'Use content_base64 for content containing special characters.',
    parameters: WRITE_SCHEMA as Record<string, unknown>,
    sideEffects: ['write_fs'],
    concurrency: 'serial',
    supportsProgress: true,
  };

  return {
    definition,
    async execute(args: Record<string, unknown>, executeOptions?: ToolExecuteOptions) {
      const authenticated = assertCurrentToolInvocation(args, executeOptions);
      const assertCurrent = () => { assertCurrentToolInvocation(args, executeOptions); };
      // Runtime validation before cast: ensure required fields exist.
      if (!args['files'] || !Array.isArray(args['files']) || (args['files'] as unknown[]).length === 0) {
        return {
          success: false,
          error: "Invalid input: 'files' must be a non-empty array.",
        };
      }
      const input = args as unknown as WriteInput;
      const verbosity = input.verbosity ?? 'count_only';
      const dryRun = input.dry_run ?? false;

      const results: FileWriteResult[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      const pendingUndo: Array<{ path: string; beforeContent: string | null; afterContent: string; tool: 'write' }> = [];
      const transactionMode = input.transaction?.mode ?? 'none';
      // Snapshots for atomic rollback: map from resolvedPath -> original content (null = new file)
      const snapshots = new Map<string, string | Buffer | null>();
      const snapshotModes = new Map<string, number>();
      const captured = hasCapturedToolInvocation();
      const capturedAtomic = captured && transactionMode === 'atomic';
      const revisions = new Map<string, CapturedWriteRevision>();
      const ownedRevisions = new Map<string, () => void>();
      const initialRevisions = new Map<string, CapturedWriteRevision>();
      const backups = new Map<WriteFileInput, Awaited<ReturnType<typeof prepareCapturedToolBackup>>>();

      async function rollbackAtomic(failedPath: string, failure: string): Promise<{ success: false; error: string; warnings?: string[] }> {
        const rolledBack: string[] = [];
        const rollbackFailures: string[] = [];
        for (const written of [...new Map(results.filter((result) => !result.would_write).map((result) => [result.resolved_path, result])).values()]) {
          try {
            if (capturedAtomic) {
              await assertCapturedToolReadAccess(written.resolved_path);
              const revision = revisions.get(written.resolved_path);
              if (!revision) throw new Error('Captured rollback has no owned revision');
              assertCapturedToolWriteRevision(written.resolved_path, revision);
            }
            if (authenticated) {
              const revision = ownedRevisions.get(written.resolved_path);
              if (!revision) throw new Error('Rollback has no completed owned file revision');
              revision(); // Narrow inverse only, never a fresh forward mutation grant.
            }
            assertCapturedToolMutationCurrent(written.resolved_path);
            const snapshot = snapshots.get(written.resolved_path);
            if (snapshot === null || snapshot === undefined) {
              // File was new - delete it, and the bookkeeping that named it.
              unlinkSync(written.resolved_path);
              options?.fileCache?.invalidate(written.resolved_path);
              options?.projectIndex?.removeFile(written.resolved_path);
              removeCreatedDirectories(written);
            } else {
              // File existed before - restore original
              atomicWrite(written.resolved_path, snapshot);
              const mode = snapshotModes.get(written.resolved_path);
              if (mode !== undefined) chmodSync(written.resolved_path, mode);
              options?.fileCache?.update(written.resolved_path, snapshot.toString());
              // The original is back in place; this call's own backup copy of it is redundant.
              if (!captured && written.backup_path && existsSync(written.backup_path)) {
                try { unlinkSync(written.backup_path); } catch { /* a leftover backup is harmless */ }
              }
            }
            rolledBack.push(written.path);
          } catch (rollbackErr) {
            const rollbackFailure = `Failed to roll back '${written.path}': ${summarizeError(rollbackErr)}`;
            rollbackFailures.push(rollbackFailure);
            logger.warn('write tool: atomic rollback failed', {
              path: written.resolved_path,
              error: summarizeError(rollbackErr),
            });
          }
        }
        const rollbackDetail = rollbackFailures.length > 0
          ? `. Rollback failures: ${rollbackFailures.join('; ')}`
          : '';
        const failMsg = `Atomic transaction failed on '${failedPath}': ${failure}. Rolled back ${rolledBack.length} file(s): ${rolledBack.join(', ')}${rollbackDetail}`;
        return {
          success: false,
          error: failMsg,
          ...(rollbackFailures.length > 0 ? { warnings: rollbackFailures } : {}),
        };
      }

      // Atomic captured batches admit and validate every path before effects.
      // Repair can await between writes. Exact initial/owned revisions therefore
      // guard every subsequent write and rollback under the shared view lock.
      if (capturedAtomic) {
        const willExist = new Set<string>();
        for (const fileInput of input.files) {
          if (!fileInput.path || typeof fileInput.path !== 'string')
            return { success: false, error: "Atomic transaction has an invalid file path" };
          const path = resolveWritablePath(fileInput.path, projectRoot);
          await assertCapturedToolReadAccess(path);
          if (options.capturedReadAccess && !await options.capturedReadAccess(path))
            throw new Error('Captured write path is access-restricted');
          const checked = processSingleWrite(fileInput, projectRoot, true);
          if (!checked.ok) return { success: false, error: `Atomic transaction failed on '${fileInput.path}': ${checked.error}` };
          if (willExist.has(path) && (fileInput.mode ?? 'fail_if_exists') === 'fail_if_exists')
            return { success: false, error: `Atomic transaction would create '${fileInput.path}' more than once` };
          willExist.add(path);
          if (!snapshots.has(path)) {
            snapshots.set(path, existsSync(path) ? readFileSync(path) : null);
            if (existsSync(path)) snapshotModes.set(path, statSync(path).mode & 0o777);
          }
          if (fileInput.mode === 'backup') backups.set(fileInput, await prepareCapturedToolBackup(path, dryRun));
        }
        for (const path of snapshots.keys()) await assertCapturedToolReadAccess(path);
        for (const backup of backups.values()) await backup.assertCurrent();
        assertCapturedToolMutationCurrent();
        for (const [path, before] of snapshots) {
          assertCapturedToolMutationCurrent(path);
          if (before === null ? existsSync(path) : !existsSync(path) || !Buffer.from(before).equals(readFileSync(path)) || (snapshotModes.has(path) && (statSync(path).mode & 0o777) !== snapshotModes.get(path)))
            throw new Error('Captured atomic write conflicts with changed input');
          if (before !== null) initialRevisions.set(path, captureCapturedToolWriteRevision(path, Buffer.from(before)));
        }
      }

      // A throw part-way through a non-atomic batch leaves earlier files on
      // disk; the error then names them so a retry does not redo blind.
      try {
      for (const [fileIndex, fileInput] of input.files.entries()) {
        if (!fileInput || !fileInput.path || typeof fileInput.path !== 'string') {
          const error = `files[${fileIndex}]: invalid file entry: missing or invalid 'path' field.`;
          if (transactionMode === 'atomic') return await rollbackAtomic(String(fileInput?.path ?? '<invalid>'), error);
          errors.push(error);
          continue;
        }

        if (!capturedAtomic && (captured || options.capturedReadAccess)) {
          try {
            const path = resolveWritablePath(fileInput.path, projectRoot);
            await assertCapturedToolReadAccess(path);
            if (options.capturedReadAccess && !await options.capturedReadAccess(path)) {
              const error = 'Captured write path is access-restricted';
              if (transactionMode === 'atomic') return await rollbackAtomic(fileInput.path, error);
              errors.push(`${fileInput.path}: ${error}`);
              continue;
            }
            if (captured && fileInput.mode === 'backup') backups.set(fileInput, await prepareCapturedToolBackup(path, dryRun));
          } catch (error) {
            if (transactionMode === 'atomic') return await rollbackAtomic(fileInput.path, summarizeError(error));
            throw error;
          }
        }
        let preparationError: string | undefined;
        try {
          assertCurrent();
          if (captured) {
            const path = resolveWritablePath(fileInput.path, projectRoot);
            if (capturedAtomic) {
              await assertCapturedToolReadAccess(path);
              const revision = revisions.get(path) ?? initialRevisions.get(path);
              if (revision) assertCapturedToolWriteRevision(path, revision);
              else if (existsSync(path)) throw new Error('Captured atomic write conflicts with newly created input');
            }
            assertCapturedToolMutationCurrent(path);
          }
        } catch (error) { preparationError = summarizeError(error); }

        // Capture before-content for undo and atomic transaction snapshots BEFORE the write happens
        let beforeContent: string | null = null;
        let beforeBytes: Buffer | null = null;
        let existedBeforeWrite = false;
        // Undo compares the file read as UTF-8; a latin1/ascii/binary write would never match, so it gets no undo entry.
        let undoable = !fileInput.encoding || fileInput.encoding === 'utf-8' || fileInput.encoding === 'utf8';
        if (!preparationError && !dryRun && fileInput.path) {
          let resolvedForUndo: string | undefined;
          try {
            resolvedForUndo = resolveWritablePath(fileInput.path, projectRoot);
          } catch (err) {
            logger.warn('write tool: failed to resolve path for before-write snapshot', {
              path: fileInput.path,
              error: summarizeError(err),
            });
            resolvedForUndo = undefined;
          }
          if (resolvedForUndo && existsSync(resolvedForUndo)) {
            existedBeforeWrite = true;
            try {
              beforeBytes = readFileSync(resolvedForUndo);
              beforeContent = beforeBytes.toString('utf-8');
              // Undo restores text; a file that is not valid UTF-8 would come back altered, so it gets no undo entry.
              if (!Buffer.from(beforeContent, 'utf-8').equals(beforeBytes)) { undoable = false; beforeContent = null; }
              if (authenticated && transactionMode === 'atomic') captureFileEffectRevision(resolvedForUndo, beforeBytes)();
            } catch (err) {
              const warning = `Failed to read existing content before writing '${fileInput.path}': ${summarizeError(err)}`;
              if (transactionMode === 'atomic') {
                const failure = await rollbackAtomic(fileInput.path, `Atomic transaction cannot safely snapshot '${fileInput.path}': ${summarizeError(err)}`);
                return { ...failure, warnings: [warning, ...failure.warnings ?? []] };
              }
              appendWarning(warnings, `${warning}. Undo snapshot will not include original content.`);
              beforeContent = null;
            }
          }
          // Store snapshot for atomic transaction rollback
          if (transactionMode === 'atomic' && resolvedForUndo && !snapshots.has(resolvedForUndo)) {
            try {
              snapshots.set(resolvedForUndo, existedBeforeWrite ? beforeBytes : null);
              if (existedBeforeWrite) snapshotModes.set(resolvedForUndo, statSync(resolvedForUndo).mode & 0o777);
            } catch (err) {
              return await rollbackAtomic(fileInput.path, `Atomic transaction cannot safely snapshot '${fileInput.path}': ${summarizeError(err)}`);
            }
          }
        }

        const outcome = preparationError
          ? { ok: false as const, error: preparationError }
          : processSingleWrite(fileInput, projectRoot, dryRun, backups.get(fileInput), capturedAtomic ? revisions.get(resolveWritablePath(fileInput.path, projectRoot)) : undefined, assertCurrent);

        if (!outcome.ok) {
          errors.push(outcome.error.includes(fileInput.path) ? outcome.error : `${fileInput.path}: ${outcome.error}`);
          logger.warn('write tool: file write failed', { path: fileInput.path, error: outcome.error });

          // Atomic transaction: rollback all successfully written files
          if (transactionMode === 'atomic') return await rollbackAtomic(fileInput.path, outcome.error);

          continue;
        }

        results.push(outcome.result);
        // The bytes this write put on disk: exact for a binary payload, the encoded text otherwise.
        const writtenBytes = () => outcome.result._bytes ?? Buffer.from(outcome.result._content ?? '', (fileInput.encoding as BufferEncoding) ?? 'utf-8');
        if (authenticated && !dryRun) ownedRevisions.set(outcome.result.resolved_path, captureFileEffectRevision(outcome.result.resolved_path, writtenBytes()));
        if (captured && !dryRun && (capturedAtomic || options.fileUndoManager)) {
          revisions.set(outcome.result.resolved_path, captureCapturedToolWriteRevision(outcome.result.resolved_path, writtenBytes()));
        }

        // State integration, only for real writes, not dry runs
        if (!dryRun) {
          let content = outcome.result._content ?? '';
          const retainedPath = outcome.result.resolved_path;
          const writeResult = outcome.result;
          async function recordRetainedCapturedWrite(): Promise<void> {
            if (!captured || !options?.fileUndoManager || !undoable || writeResult._bytes) return;
            // A failed repair can leave its initial write intact. History must
            // only describe bytes still owned under live read/mutation authority.
            try {
              await assertCapturedToolReadAccess(retainedPath);
              if (options.capturedReadAccess && !await options.capturedReadAccess(retainedPath))
                throw new Error('Captured write path is access-restricted');
              const revision = revisions.get(retainedPath);
              if (!revision) throw new Error('Captured failed repair has no owned revision');
              assertCapturedToolWriteRevision(retainedPath, revision);
              options.fileUndoManager.snapshot({ path: retainedPath, beforeContent, afterContent: content, tool: 'write' });
            } catch (historyError) {
              logger.warn('write tool: failed repair undo snapshot withheld', { path: retainedPath, error: summarizeError(historyError) });
            }
          }

          let recorded = false;
          // File cache, project index, undo and change tracking for this file;
          // also run when a later step throws, so history covers every write.
          function recordWriteState(): void {
            if (recorded || !outcome.ok) return;
            recorded = true;
            const byteSize = outcome.result._bytes?.length ?? Buffer.byteLength(content, 'utf-8');
            const tokenEstimate = Math.ceil(byteSize / 4);
            const binaryPayload = outcome.result._bytes !== undefined;

            if (options?.fileCache && !binaryPayload) {
              try {
                options.fileCache.update(outcome.result.resolved_path, content, { tool: 'write' });
              } catch (err) {
                appendWarning(
                  warnings,
                  `File cache update failed for '${outcome.result.path}': ${summarizeError(err)}`,
                  outcome.result,
                );
                logger.warn('write tool: fileCache.update failed', {
                  path: outcome.result.resolved_path,
                  error: summarizeError(err),
                });
              }
            }

            if (options?.projectIndex && !binaryPayload) {
              try {
                options.projectIndex.upsertFile(outcome.result.resolved_path, tokenEstimate);
              } catch (err) {
                appendWarning(
                  warnings,
                  `Project index update failed for '${outcome.result.path}': ${summarizeError(err)}`,
                  outcome.result,
                );
                logger.warn('write tool: projectIndex.upsertFile failed', {
                  path: outcome.result.resolved_path,
                  error: summarizeError(err),
                });
              }
            }

            // Snapshot for /undo file support
            if (options?.fileUndoManager && (!undoable || binaryPayload)) {
              appendWarning(
                warnings,
                `Undo history was not recorded for '${outcome.result.path}': binary content cannot be restored byte for byte by /undo.`,
                outcome.result,
              );
            } else if (options?.fileUndoManager) {
              try {
                const snapshot = { path: outcome.result.resolved_path, beforeContent, afterContent: content, tool: 'write' as const };
                if (transactionMode === 'atomic') pendingUndo.push(snapshot);
                else options.fileUndoManager.snapshot(snapshot);
              } catch (err) {
                appendWarning(
                  warnings,
                  `Undo snapshot failed for '${outcome.result.path}': ${summarizeError(err)}`,
                  outcome.result,
                );
                logger.warn('write tool: fileUndoManager.snapshot failed', {
                  path: outcome.result.resolved_path,
                  error: summarizeError(err),
                });
              }
            }

            logger.debug('write tool: wrote file', {
              path: outcome.result.resolved_path,
              bytes: byteSize,
              mode: outcome.result.mode_applied,
            });
            // Track for /diff session change view
            if (options?.changeTracker) {
              try {
                options.changeTracker.recordChange(outcome.result.resolved_path);
              } catch (err) {
                appendWarning(
                  warnings,
                  `Change tracker update failed for '${outcome.result.path}': ${summarizeError(err)}`,
                  outcome.result,
                );
                logger.warn('write tool: changeTracker.recordChange failed', {
                  path: outcome.result.resolved_path,
                  error: summarizeError(err),
                });
              }
            }
          }

          // Auto-heal: if file is JS/TS and auto-heal is enabled, run syntax check
          let autoHealEnabled = false;
          if (options?.configManager) {
            try {
              autoHealEnabled = Boolean(options.configManager.get('tools.autoHeal'));
            } catch (err) {
              appendWarning(
                warnings,
                `Auto-heal configuration check failed for '${outcome.result.path}': ${summarizeError(err)}`,
                outcome.result,
              );
            }
          }
          if (autoHealEnabled && outcome.result._bytes === undefined) {
            const ext = extname(outcome.result.resolved_path).toLowerCase();
            const isJsTs = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext);
            if (isJsTs) {
              try {
                const loader = (ext === '.mjs' || ext === '.cjs') ? 'js' : ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
                const transpiler = new Bun.Transpiler({ loader });
                transpiler.transformSync(content);
              } catch (syntaxErr) {
                const syntaxErrors = [String(syntaxErr)];
                outcome.result.auto_heal = { attempted: true, healed: false };
                let healResult: Awaited<ReturnType<typeof healToolFile>>;
                try {
                  healResult = options.toolLLM && options.configManager
                  ? await healToolFile(options.configManager, options.toolLLM, outcome.result.resolved_path, content, syntaxErrors, options.capturedAutoHeal, authenticated ? assertCurrent : undefined, executeOptions?.signal)
                  : {
                      healed: false,
                      content,
                      assertCurrent: async () => {}, assertCurrentSynchronous: () => {},
                      method: undefined,
                      warnings: [`Auto-heal skipped for '${outcome.result.path}': tool LLM is not configured`],
                    };
                } catch (error) {
                  if (transactionMode === 'atomic') {
                    const failure = await rollbackAtomic(fileInput.path, `Auto-heal failed: ${summarizeError(error)}`);
                    if (capturedAtomic) return failure;
                    if (failure.warnings?.length && error instanceof Error) {
                      try { error.message += `. Atomic rollback incomplete: ${failure.warnings.join('; ')}`; }
                      catch { /* Frozen errors must retain their original identity and classification. */ }
                    }
                  } else if (captured) await recordRetainedCapturedWrite();
                  else recordWriteState();
                  // Ordinary terminal judgment failures still propagate after rollback.
                  throw error;
                }
                for (const warning of healResult.warnings ?? []) {
                  appendWarning(warnings, warning, outcome.result);
                }
                if (healResult.healed) {
                  logger.debug('write tool: auto-heal succeeded', {
                    path: outcome.result.resolved_path,
                    method: healResult.method,
                  });
                  // Rewrite file with healed content
                  try {
                    if (captured) {
                      await healResult.assertCurrent();
                      healResult.assertCurrentSynchronous();
                      assertCapturedToolMutationCurrent(outcome.result.resolved_path);
                    }
                    assertCurrent();
                    if (authenticated) ownedRevisions.get(outcome.result.resolved_path)!();
                    atomicWrite(outcome.result.resolved_path, healResult.content);
                    if (authenticated) ownedRevisions.set(outcome.result.resolved_path, captureFileEffectRevision(outcome.result.resolved_path, Buffer.from(healResult.content)));
                    content = healResult.content;
                    outcome.result._content = content;
                    outcome.result.bytes_written = Buffer.byteLength(content, 'utf-8');
                    outcome.result.auto_heal = {
                      attempted: true,
                      healed: true,
                      method: healResult.method,
                    };
                  } catch (writeErr) {
                    if (transactionMode === 'atomic') return await rollbackAtomic(fileInput.path, `Auto-heal rewrite failed: ${summarizeError(writeErr)}`);
                    if (captured) {
                      await recordRetainedCapturedWrite();
                      throw writeErr;
                    }
                    logger.warn('write tool: auto-heal rewrite failed', {
                      path: outcome.result.resolved_path,
                      error: summarizeError(writeErr),
                    });
                    appendWarning(
                      warnings,
                      `Auto-heal produced repaired content for '${outcome.result.path}' but rewrite failed: ${summarizeError(writeErr)}`,
                      outcome.result,
                    );
                  }
                } else {
                  appendWarning(
                    warnings,
                    `Auto-heal could not repair syntax errors in '${outcome.result.path}': ${summarizeError(syntaxErr)}`,
                    outcome.result,
                  );
                }
              }
            }
          }

          if (capturedAtomic) revisions.set(outcome.result.resolved_path, captureCapturedToolWriteRevision(outcome.result.resolved_path, outcome.result._bytes ?? Buffer.from(content, (fileInput.encoding as BufferEncoding) ?? 'utf-8')));
          recordWriteState();
        }
      }
      } catch (error) {
        annotateWrittenFiles(error, results, transactionMode);
        throw error;
      }

      if (errors.length > 0 && results.length === 0) {
        return {
          success: false,
          error: errors.join('\n'),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      for (const snapshot of pendingUndo) {
        try { options.fileUndoManager?.snapshot(snapshot); }
        catch (error) { appendWarning(warnings, `Undo snapshot failed for '${snapshot.path}': ${summarizeError(error)}`); }
      }

      const output = formatOutput(results, errors, verbosity, dryRun);

      // Attach partial errors to output if some succeeded and some failed
      const finalOutput: Record<string, unknown> = { ...output };
      if (errors.length > 0) {
        finalOutput.errors = errors;
        // count_only carries no file list; on a partial failure the model
        // still needs to know which files landed.
        if (!finalOutput.files) finalOutput.written_paths = results.map((result) => result.path);
      }

      // Post-write validation, run after all files are written, even if partial errors occurred
      if (!dryRun && results.length > 0 && input.validate?.after && input.validate.after.length > 0) {
        const validatorNames = input.validate.after as ValidatorName[];
        logger.debug('write tool: running post-write validators', { validators: validatorNames });
        try {
          const failures = await runValidators(validatorNames, projectRoot, options.validatorRunner, assertCurrent, executeOptions?.signal);
          if (failures.length > 0) {
            finalOutput.validation_failures = failures.map((f) => ({
              validator: f.validator,
              passed: false,
              exit_code: f.exitCode,
              stdout: f.stdout.trim(),
              stderr: f.stderr.trim(),
              message: formatValidatorFailure(f),
            }));
            logger.warn('write tool: post-write validators failed', {
              count: failures.length,
              validators: failures.map((f) => f.validator),
            });
            appendWarning(
              warnings,
              `Post-write validation failed for validator(s): ${failures.map((f) => f.validator).join(', ')}. The ${results.length} written file(s) were kept on disk, not rolled back; fix them or restore them yourself.`,
            );
          } else {
            finalOutput.validation_passed = true;
          }
        } catch (validationErr) {
          const validationMessage = summarizeError(validationErr);
          logger.warn('write tool: validator execution error', { error: validationMessage });
          finalOutput.validation_error = validationMessage;
          appendWarning(warnings, `Post-write validator execution failed: ${validationMessage}`);
        }
      }

      // Post-edit diagnostics, cheap, in-process syntax check of each file we
      // just wrote, appended so the model sees a broken edit immediately. Off
      // when configured off; absent (no field) when the provider produces
      // nothing (honest absence, never a fabricated "no errors").
      if (!dryRun && results.length > 0 && options.diagnosticsProvider
        && (options.configManager?.get('diagnostics.postEdit') ?? 'on') === 'on') {
        const touched = results
          .filter((r) => !r.would_write && typeof r._content === 'string')
          .map((r) => ({ path: r.resolved_path, content: r._content as string }));
        const diagnostics = await collectPostEditDiagnostics(options.diagnosticsProvider, touched);
        if (diagnostics.length > 0) {
          finalOutput.diagnostics = diagnostics;
        }
      }

      if (warnings.length > 0) {
        finalOutput.warnings = warnings;
      }

      return {
        success: errors.length === 0,
        output: JSON.stringify(finalOutput),
        ...(errors.length > 0
          ? { error: `${errors.length} of ${input.files.length} file(s) failed; ${results.length} written. First failure: ${errors[0]}` }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}
