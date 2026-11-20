import { assertCurrentToolInvocation } from '../registry.js';
import type { CapturedWriteRevision } from '../shared/captured-write-revision.js';
import { assertCapturedToolWriteRevision, captureCapturedToolWriteRevision, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation, prepareCapturedToolBackup } from '../shared/captured-input-tools.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import { chmodSync, constants, lstatSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync, copyFileSync, unlinkSync, type BigIntStats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import { WRITE_SCHEMA, WRITE_TEXT_ENCODINGS, type WriteInput, type WriteFileInput, type WriteMode } from './schema.js';
import { runValidators, capValidatorOutput, describeUndeclaredValidators, undeclaredValidators, validatorSettings, type ValidatorName, type ValidatorRunner } from '../shared/validators.js';
import { FileStateCache } from '../../state/file-cache.js';
import { ProjectIndex } from '../../state/project-index.js';
import { FileUndoManager } from '../../state/file-undo.js';
import { noteToolWrites, watchIndexedFile } from '../../state/file-watcher.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { healToolFile, type CapturedAutoHealBackend } from '../shared/captured-auto-heal.js';
import { isNotebookFile } from '../../utils/notebook.js';
import { logger } from '../../utils/logger.js';
import type { SessionChangeTracker } from '../../sessions/change-tracker.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveWritablePath } from '../../utils/path-safety.js';
import { noteSourceFilesWritten } from '../../intelligence/import-graph.js';
import { collectPostEditDiagnostics, type DiagnosticsProvider } from '../shared/post-edit-diagnostics.js';
import { ToolInputProjectionError } from '../input-projection.js';
import { declaredRecoverable } from '../../gate/classify.js';
import { isYoloExecution } from '../../gate/execution-context.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface FileWriteResult {
  path: string;
  resolved_path: string;
  bytes_written: number;
  mode_applied: WriteMode;
  backup_path?: string | undefined;
  /** The backup copy a `restore` write put back. */
  restored_from?: string | undefined;
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
  /** Stamp of the file this write left on disk (see fileStamp). */
  _stamp?: string | undefined;
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
  /** Where each `backup` copy went, when there is no file list to carry it. */
  backups?: Array<{ path: string; backup_path: string }> | undefined;
  /** Which backup each `restore` put back, when there is no file list to carry it. */
  restored?: Array<{ path: string; restored_from: string }> | undefined;
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

/** Backups kept per file; a newer backup removes the oldest beyond this. */
const BACKUPS_KEPT_PER_FILE = 5;
/** `<ms>` or, for a second backup in the same millisecond, `<ms>_<n>`. */
const BACKUP_SUFFIX = /^(\d+)(?:_(\d+))?$/;

/**
 * Where a file's backups live: src/foo.ts -> <projectRoot>/.goodvibes/.backups/src/ with names foo.ts.<ms>.
 * A file outside the project goes under .backups/_outside/<sha256 of its path>/, so its backups never
 * land among, or are pruned from, another directory's own files.
 */
function backupLocation(resolvedPath: string, projectRoot: string): { directory: string; name: string } {
  // resolvedPath is resolved against the real project root, so the backup path is too.
  const root = realpathSync(resolvePath(projectRoot), 'utf8');
  const rel = relative(root, resolvedPath);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const target = outside
    ? join(root, '.goodvibes', '.backups', '_outside', createHash('sha256').update(resolvedPath).digest('hex'), basename(resolvedPath))
    : join(root, '.goodvibes', '.backups', rel);
  return { directory: dirname(target), name: basename(target) };
}

/** A file's backups made by mode `backup`, newest first. */
function listBackups(resolvedPath: string, projectRoot: string): string[] {
  const { directory, name } = backupLocation(resolvedPath, projectRoot);
  let entries: string[];
  try { entries = readdirSync(directory); } catch { return []; }
  const found: Array<{ path: string; at: number; seq: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`)) continue;
    const match = BACKUP_SUFFIX.exec(entry.slice(name.length + 1));
    if (match) found.push({ path: join(directory, entry), at: Number(match[1]), seq: Number(match[2] ?? 0) });
  }
  return found.sort((a, b) => b.at - a.at || b.seq - a.seq).map((backup) => backup.path);
}

/** A backup name no earlier backup of the file has, even within one millisecond. */
function nextBackupPath(resolvedPath: string, projectRoot: string): string {
  const { directory, name } = backupLocation(resolvedPath, projectRoot);
  const at = Date.now();
  let candidate = join(directory, `${name}.${at}`);
  for (let seq = 1; existsSync(candidate); seq += 1) candidate = join(directory, `${name}.${at}_${seq}`);
  return candidate;
}

function pruneBackups(resolvedPath: string, projectRoot: string): void {
  for (const old of listBackups(resolvedPath, projectRoot).slice(BACKUPS_KEPT_PER_FILE)) {
    try { unlinkSync(old); } catch { /* an old copy that cannot be removed stays */ }
  }
}

/** The newest backup of a file, as the content a `restore` write puts back. */
function resolveRestore(
  fileInput: WriteFileInput,
  resolvedPath: string,
  projectRoot: string,
): { ok: true; content: ResolvedContent; from: string } | { ok: false; error: string } {
  if (hasCapturedToolInvocation()) {
    return { ok: false, error: `Mode 'restore' is not available in a contract's working copy, which has no backups of its own. Write the content with mode 'overwrite'. Nothing was written.` };
  }
  if (fileInput.content !== undefined || fileInput.content_base64 !== undefined) {
    return { ok: false, error: `Mode 'restore' takes no content for '${fileInput.path}': it writes back the newest backup. Omit content and content_base64. Nothing was written.` };
  }
  if (fileInput.encoding && fileInput.encoding !== 'utf-8' && fileInput.encoding !== 'utf8') {
    return { ok: false, error: `encoding '${fileInput.encoding}' does not apply to mode 'restore', which writes the backup's bytes exactly; omit it. Nothing was written.` };
  }
  const newest = listBackups(resolvedPath, projectRoot)[0];
  if (newest === undefined) {
    return { ok: false, error: `No backup of '${fileInput.path}' in .goodvibes/.backups: a backup is made only by a write with mode 'backup'. Nothing was written.` };
  }
  let bytes: Buffer;
  try { bytes = readFileSync(newest); } catch (err) {
    return { ok: false, error: `Could not read the backup '${newest}' of '${fileInput.path}': ${summarizeError(err)}. Nothing was written.` };
  }
  const text = bytes.toString('utf-8');
  return { ok: true, from: newest, content: Buffer.from(text, 'utf-8').equals(bytes) ? { kind: 'text', text } : { kind: 'bytes', bytes } };
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

function statIfPresent(path: string): BigIntStats | undefined {
  return statSync(path, { bigint: true, throwIfNoEntry: false });
}

const stampOf = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;

/**
 * Identity and change time of the file a path names, links followed; null when
 * there is none. Two equal stamps mean nothing replaced or wrote the file between them.
 */
function fileStamp(path: string): string | null {
  const stat = statIfPresent(path);
  return stat ? stampOf(stat) : null;
}

/** The one refusal for a file that changed underneath this call. */
function changedOnDisk(path: string): string {
  return `'${path}' changed on disk while this call was running (another program wrote to it), so it was not overwritten. Read it again and retry`;
}

/** What this call last saw or wrote at a path. */
interface PathState {
  readonly bytes: Buffer | null;
  readonly stamp: string | null;
  readonly mode?: number | undefined;
}

/** Read a path's content once, with the stamp taken before the read: a change after the stamp makes a later comparison fail, never pass. */
function readPathState(path: string): PathState {
  const stat = statIfPresent(path);
  if (!stat) return { bytes: null, stamp: null };
  return { bytes: readFileSync(path), stamp: stampOf(stat), mode: Number(stat.mode & 0o777n) };
}

/**
 * Atomically write content to a file: a temp file renamed over the target.
 * With `expectedStamp`, the target must still be what that stamp names right
 * before the rename (null: must not exist). Returns the stamp of the written file.
 */
function atomicWrite(requestedPath: string, content: string | Buffer, encoding: BufferEncoding = 'utf-8', expectedStamp?: string | null): string {
  // A symbolic link is written through: replacing the link itself with a regular file
  // would drop the link and give the new file the link's 0777 mode.
  const targetPath = followLinks(requestedPath);
  const rand = randomBytes(4).toString('hex');
  const tmpPath = `${targetPath}.tmp.${rand}`;
  try {
    // Keep the temporary inode private until all bytes have been written.
    writeFileSync(tmpPath, content, { encoding, flag: 'wx', mode: 0o600 });
    const existing = statIfPresent(targetPath);
    if (expectedStamp !== undefined && (existing ? stampOf(existing) : null) !== expectedStamp) throw new Error(changedOnDisk(requestedPath));
    chmodSync(tmpPath, existing ? Number(existing.mode & 0o777n) : 0o666 & ~process.umask());
    renameSync(tmpPath, targetPath);
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
  // The import graph is patched with the new text instead of being rebuilt.
  noteSourceFilesWritten(new Map([[requestedPath, typeof content === 'string' ? content : content.toString('utf-8')]]));
  noteToolWrites(requestedPath === targetPath ? [targetPath] : [requestedPath, targetPath]);
  return stampOf(statSync(targetPath, { bigint: true }));
}

// ---------------------------------------------------------------------------
// Core write logic
// ---------------------------------------------------------------------------

/** What one file write needs that the call already established. */
interface SingleWriteContext {
  /** The path as resolveWritablePath returned it, resolved once per call. */
  readonly resolvedPath: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  /** Whether the file existed, when the call already knows; looked up otherwise. */
  readonly existed?: boolean | undefined;
  /** The stamp the target must still have right before the rename (atomic batches). */
  readonly expectedStamp?: string | null | undefined;
  readonly capturedBackup?: Awaited<ReturnType<typeof prepareCapturedToolBackup>> | undefined;
  readonly sourceRevision?: CapturedWriteRevision | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/** The text or bytes a `content`/`content_base64` entry writes, or why it cannot be written. */
function resolveInputContent(fileInput: WriteFileInput): { ok: true; content: ResolvedContent; encoding: BufferEncoding } | { ok: false; error: string } {
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
        : `Invalid encoding: '${fileInput.encoding}'. Valid: ${textEncodings.join(', ')}. Nothing was written.`,
    };
  }
  if (fileInput.content_base64 !== undefined && fileInput.encoding && fileInput.encoding !== 'utf-8' && fileInput.encoding !== 'utf8') {
    return { ok: false, error: `encoding '${fileInput.encoding}' does not apply to content_base64, which is written as the decoded bytes; omit it. Nothing was written.` };
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
  // A narrow text encoding re-encodes each character; one it cannot hold would be written as something else.
  if (resolvedContent.kind === 'text' && fileInput.content !== undefined && encoding !== 'utf-8' && encoding !== 'utf8'
    && Buffer.from(resolvedContent.text, encoding).toString(encoding) !== resolvedContent.text) {
    return { ok: false, error: `The text for '${fileInput.path}' has characters that encoding '${encoding}' cannot hold; use utf-8. Nothing was written.` };
  }
  return { ok: true, content: resolvedContent, encoding };
}

/**
 * Write one file entry: validate its content, back up or refuse per its
 * mode, then write it. The target is unchanged when it returns an error.
 */
function processSingleWrite(
  fileInput: WriteFileInput,
  context: SingleWriteContext,
): { ok: true; result: FileWriteResult } | { ok: false; error: string } {
  const { resolvedPath, projectRoot, dryRun, capturedBackup, sourceRevision } = context;
  const assertCurrent = context.assertCurrent ?? (() => {});
  const mode: WriteMode = fileInput.mode ?? 'fail_if_exists';

  let resolvedContent: ResolvedContent;
  let encoding: BufferEncoding = 'utf-8';
  let restoredFrom: string | undefined;
  if (mode === 'restore') {
    const restore = resolveRestore(fileInput, resolvedPath, projectRoot);
    if (!restore.ok) return restore;
    resolvedContent = restore.content;
    restoredFrom = restore.from;
  } else {
    const input = resolveInputContent(fileInput);
    if (!input.ok) return input;
    resolvedContent = input.content;
    encoding = input.encoding;
  }
  let content = resolvedContent.kind === 'text' ? resolvedContent.text : '';

  // Notebook validation and normalization; a restored backup is written back exactly as it was.
  if (restoredFrom === undefined && resolvedContent.kind === 'text' && isNotebookFile(resolvedPath)) {
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

  const alreadyExists = context.existed ?? existsSync(resolvedPath);

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
    ...(restoredFrom !== undefined ? { restored_from: restoredFrom } : {}),
    ...(resolvedContent.kind === 'bytes' ? { _bytes: resolvedContent.bytes } : { _content: content }),
  };

  if (dryRun) {
    result.would_write = true;
    if (alreadyExists && mode === 'backup') {
      result.backup_path = capturedBackup?.path ?? nextBackupPath(resolvedPath, projectRoot);
    }
    return { ok: true, result };
  }

  // Backup if needed
  if (alreadyExists && mode === 'backup') {
    if (hasCapturedToolInvocation() && !capturedBackup) return { ok: false, error: 'Captured backup requires its prepared owned destination' };
    try {
      assertCurrent();
      let backupPath: string;
      if (capturedBackup) {
        backupPath = capturedBackup.path;
        capturedBackup.create(sourceRevision);
      } else {
        backupPath = nextBackupPath(resolvedPath, projectRoot);
        mkdirSync(dirname(backupPath), { recursive: true });
        assertCurrent();
        copyFileSync(resolvedPath, backupPath, constants.COPYFILE_EXCL);
        pruneBackups(resolvedPath, projectRoot);
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
    result._stamp = atomicWrite(resolvedPath, resolvedContent.kind === 'bytes' ? resolvedContent.bytes : content, encoding, context.expectedStamp);
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
    // Copies made and put back are on disk whatever the verbosity; say where.
    const backups = results.flatMap((r) => r.backup_path ? [{ path: r.path, backup_path: r.backup_path }] : []);
    if (backups.length > 0) base.backups = backups;
    const restored = results.flatMap((r) => r.restored_from ? [{ path: r.path, restored_from: r.restored_from }] : []);
    if (restored.length > 0) base.restored = restored;
    return base;
  }

  if (verbosity === 'minimal') {
    base.files = results.map((r) => ({
      path: r.path,
      resolved_path: r.resolved_path,
      bytes_written: r.bytes_written,
      mode_applied: r.mode_applied,
      ...(r.backup_path ? { backup_path: r.backup_path } : {}),
      ...(r.restored_from ? { restored_from: r.restored_from } : {}),
      ...(r.would_write ? { would_write: r.would_write } : {}),
      ...(r.auto_heal ? { auto_heal: r.auto_heal } : {}),
      ...(r.warnings ? { warnings: r.warnings } : {}),
    }));
    return base;
  }

  // standard and verbose both include full results (strip internal _content field)
  base.files = results.map(({ _content: _, _bytes: __, _stamp: ___, ...r }) => r);
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
    activity: { doing: 'Writing', did: 'wrote', object: 'a file', objects: 'files' },
    // Sent in full on every model request (see ToolDefinition.core).
    core: true,
    description:
      'Write one or more files to disk. Supports batch writes, automatic parent directory creation, ' +
      'and modes fail_if_exists (default), overwrite, backup, and restore (puts the newest backup back). ' +
      'Use content_base64 for content containing special characters.',
    parameters: WRITE_SCHEMA as Record<string, unknown>,
    sideEffects: ['write_fs'],
    subjects: { paths: ['files[].path'] },
    // Undo puts back the exact bytes a write replaced (text or not) and the bytes it wrote;
    // a write in another encoding gets no undo entry, and a validator runs a project
    // command that undo cannot take back.
    ...(options.fileUndoManager ? { recoverable: { unless: ['files[].encoding', 'validate.after[]'] } } : {}),
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
      const requestedValidators = (input.validate?.after ?? []) as ValidatorName[];
      // A validator the project does not declare is reported before anything is written, not after.
      if (!dryRun && requestedValidators.length > 0 && options.validatorRunner) {
        const settings = validatorSettings(options.configManager);
        const missing = undeclaredValidators(requestedValidators, projectRoot, undefined, settings);
        if (missing.length > 0) return { success: false, error: describeUndeclaredValidators(missing, projectRoot, undefined, settings) };
      }

      const results: FileWriteResult[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      // Every file this call writes is one undo entry.
      const undoCall = options.fileUndoManager?.beginCall();
      const pendingUndo: Array<{ path: string; beforeContent: string | Buffer | null; afterContent: string | Buffer; tool: 'write'; call: number | undefined }> = [];
      const transactionMode = input.transaction?.mode ?? 'none';
      const atomic = transactionMode === 'atomic';
      // Snapshots for atomic rollback: map from resolvedPath -> original content (null = new file)
      const snapshots = new Map<string, Buffer | null>();
      const snapshotModes = new Map<string, number>();
      const captured = hasCapturedToolInvocation();
      const capturedAtomic = captured && atomic;
      const revisions = new Map<string, CapturedWriteRevision>();
      const backups = new Map<WriteFileInput, Awaited<ReturnType<typeof prepareCapturedToolBackup>>>();
      // What this call last saw or wrote at each path. A file is read at most
      // once per call; after that an equal stamp proves the bytes are these.
      const known = new Map<string, PathState>();
      // Each entry's path, resolved once.
      const resolvedPaths = new Map<WriteFileInput, string>();

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
            } else if (fileStamp(written.resolved_path) !== known.get(written.resolved_path)?.stamp) {
              // Only what this call itself left there is put back; another program's change is not overwritten.
              throw new Error('it changed on disk after this call wrote it (another program wrote to it), so it was left as it is now; read it and restore it yourself');
            }
            assertCapturedToolMutationCurrent(written.resolved_path);
            const snapshot = snapshots.get(written.resolved_path);
            if (snapshot === null || snapshot === undefined) {
              // File was new - delete it, and the bookkeeping that named it.
              unlinkSync(written.resolved_path);
              noteSourceFilesWritten(new Map([[written.resolved_path, null]]));
              noteToolWrites([written.resolved_path]);
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

      // Atomic captured batches admit, validate and snapshot every path before
      // any effect. Repair can await between writes; each write then proves its
      // target is still the snapshotted file by its stamp, right before the rename.
      if (capturedAtomic) {
        const willExist = new Set<string>();
        for (const fileInput of input.files) {
          if (!fileInput.path || typeof fileInput.path !== 'string')
            return { success: false, error: "Atomic transaction has an invalid file path" };
          const path = resolveWritablePath(fileInput.path, projectRoot);
          resolvedPaths.set(fileInput, path);
          await assertCapturedToolReadAccess(path);
          if (options.capturedReadAccess && !await options.capturedReadAccess(path))
            throw new Error('Captured write path is access-restricted');
          const checked = processSingleWrite(fileInput, { resolvedPath: path, projectRoot, dryRun: true });
          if (!checked.ok) return { success: false, error: `Atomic transaction failed on '${fileInput.path}': ${checked.error}` };
          if (willExist.has(path) && (fileInput.mode ?? 'fail_if_exists') === 'fail_if_exists')
            return { success: false, error: `Atomic transaction would create '${fileInput.path}' more than once` };
          willExist.add(path);
          if (!known.has(path)) {
            const state = readPathState(path);
            known.set(path, state);
            snapshots.set(path, state.bytes);
            if (state.mode !== undefined) snapshotModes.set(path, state.mode);
          }
          if (fileInput.mode === 'backup') backups.set(fileInput, await prepareCapturedToolBackup(path, dryRun));
        }
        for (const backup of backups.values()) await backup.assertCurrent();
        assertCapturedToolMutationCurrent();
      }

      // A throw part-way through a non-atomic batch leaves earlier files on
      // disk; the error then names them so a retry does not redo blind.
      try {
      for (const [fileIndex, fileInput] of input.files.entries()) {
        if (!fileInput || !fileInput.path || typeof fileInput.path !== 'string') {
          const error = `files[${fileIndex}]: invalid file entry: missing or invalid 'path' field.`;
          if (atomic) return await rollbackAtomic(String(fileInput?.path ?? '<invalid>'), error);
          errors.push(error);
          continue;
        }

        let path = resolvedPaths.get(fileInput);
        let pathError: unknown;
        if (path === undefined) {
          try { path = resolveWritablePath(fileInput.path, projectRoot); } catch (err) { pathError = err; }
        }
        if (path === undefined) {
          const error = `Path error for '${fileInput.path}': ${summarizeError(pathError)}`;
          if (atomic) return await rollbackAtomic(fileInput.path, error);
          if (captured) throw pathError;
          errors.push(error);
          logger.warn('write tool: file write failed', { path: fileInput.path, error });
          continue;
        }
        const resolvedPath: string = path;

        if (!capturedAtomic && (captured || options.capturedReadAccess)) {
          try {
            await assertCapturedToolReadAccess(resolvedPath);
            if (options.capturedReadAccess && !await options.capturedReadAccess(resolvedPath)) {
              const error = 'Captured write path is access-restricted';
              if (atomic) return await rollbackAtomic(fileInput.path, error);
              errors.push(`${fileInput.path}: ${error}`);
              continue;
            }
            if (captured && fileInput.mode === 'backup') backups.set(fileInput, await prepareCapturedToolBackup(resolvedPath, dryRun));
          } catch (error) {
            if (atomic) return await rollbackAtomic(fileInput.path, summarizeError(error));
            throw error;
          }
        }
        let preparationError: string | undefined;
        try {
          assertCurrent();
          if (captured) assertCapturedToolMutationCurrent(resolvedPath);
        } catch (error) { preparationError = summarizeError(error); }

        // Before-content for undo and atomic rollback, read before the write happens.
        let beforeContent: string | Buffer | null = null;
        let existedBeforeWrite: boolean | undefined;
        // Why /undo cannot restore this file, when it cannot. Undo records the
        // text written, so a write in another encoding would never match it.
        let undoSkipReason: string | undefined = !fileInput.encoding || fileInput.encoding === 'utf-8' || fileInput.encoding === 'utf8'
          ? undefined
          : `it was written in encoding '${fileInput.encoding}', which /undo cannot restore`;
        if (!preparationError && !dryRun) {
          let state = known.get(resolvedPath);
          try {
            // A path seen earlier in this call is re-read only when something else changed it since;
            // an atomic batch leaves that to the stamp check before the rename, which refuses it.
            if (state !== undefined && !atomic && fileStamp(resolvedPath) !== state.stamp) state = undefined;
            if (state === undefined) {
              state = readPathState(resolvedPath);
              known.set(resolvedPath, state);
            }
          } catch (err) {
            const warning = `Failed to read existing content before writing '${fileInput.path}': ${summarizeError(err)}`;
            if (atomic) {
              const failure = await rollbackAtomic(fileInput.path, `Atomic transaction cannot safely snapshot '${fileInput.path}': ${summarizeError(err)}`);
              return { ...failure, warnings: [warning, ...failure.warnings ?? []] };
            }
            // A call the gate let through as recoverable must stay so: without the bytes it replaces, it is not.
            if (options.fileUndoManager && declaredRecoverable(definition, args) && !isYoloExecution()) {
              errors.push(`${fileInput.path}: its content before the write could not be read (${summarizeError(err)}), so the write could not be undone; nothing was written to it. Make the file readable and write it again.`);
              continue;
            }
            appendWarning(warnings, warning);
            state = undefined;
            undoSkipReason = 'its content before the write could not be read';
          }
          if (state !== undefined) {
            existedBeforeWrite = state.bytes !== null;
            if (state.bytes !== null) {
              const text = state.bytes.toString('utf-8');
              // A file that is not valid UTF-8 text (a database, an image) is kept as its bytes, so undo puts it back exactly.
              beforeContent = Buffer.from(text, 'utf-8').equals(state.bytes) ? text : state.bytes;
            }
            // Store snapshot for atomic transaction rollback
            if (atomic && !snapshots.has(resolvedPath)) {
              snapshots.set(resolvedPath, state.bytes);
              if (state.mode !== undefined) snapshotModes.set(resolvedPath, state.mode);
            }
          }
        }

        const outcome = preparationError
          ? { ok: false as const, error: preparationError }
          : processSingleWrite(fileInput, {
              resolvedPath,
              projectRoot,
              dryRun,
              existed: existedBeforeWrite,
              // The bytes being replaced must be the snapshotted ones, or rollback would restore the wrong file.
              expectedStamp: atomic && !dryRun ? known.get(resolvedPath)?.stamp : undefined,
              capturedBackup: backups.get(fileInput),
              sourceRevision: capturedAtomic ? revisions.get(resolvedPath) : undefined,
              assertCurrent,
            });

        if (!outcome.ok) {
          errors.push(outcome.error.includes(fileInput.path) ? outcome.error : `${fileInput.path}: ${outcome.error}`);
          logger.warn('write tool: file write failed', { path: fileInput.path, error: outcome.error });

          // Atomic transaction: rollback all successfully written files
          if (atomic) return await rollbackAtomic(fileInput.path, outcome.error);

          continue;
        }

        results.push(outcome.result);
        if (!dryRun) {
          // The bytes this write put on disk: exact for a binary payload, the encoded text otherwise.
          const writtenBytes = outcome.result._bytes ?? Buffer.from(outcome.result._content ?? '', (fileInput.encoding as BufferEncoding) ?? 'utf-8');
          known.set(resolvedPath, { bytes: writtenBytes, stamp: outcome.result._stamp ?? null });
          if (captured && (capturedAtomic || options.fileUndoManager)) {
            revisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, writtenBytes));
          }
        }

        // State integration, only for real writes, not dry runs
        if (!dryRun) {
          let content = outcome.result._content ?? '';
          const retainedPath = outcome.result.resolved_path;
          const writeResult = outcome.result;
          async function recordRetainedCapturedWrite(): Promise<void> {
            if (!captured || !options?.fileUndoManager || undoSkipReason !== undefined || writeResult._bytes) return;
            // A failed repair can leave its initial write intact. History must
            // only describe bytes still owned under live read/mutation authority.
            try {
              await assertCapturedToolReadAccess(retainedPath);
              if (options.capturedReadAccess && !await options.capturedReadAccess(retainedPath))
                throw new Error('Captured write path is access-restricted');
              const revision = revisions.get(retainedPath);
              if (!revision) throw new Error('Captured failed repair has no owned revision');
              assertCapturedToolWriteRevision(retainedPath, revision);
              options.fileUndoManager.snapshot({ path: retainedPath, beforeContent, afterContent: content, tool: 'write', call: undoCall });
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
                watchIndexedFile(options.projectIndex, outcome.result.resolved_path);
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
            const noUndo = undoSkipReason;
            if (options?.fileUndoManager && noUndo !== undefined) {
              appendWarning(
                warnings,
                `Undo history was not recorded for '${outcome.result.path}': ${noUndo}.`,
                outcome.result,
              );
            } else if (options?.fileUndoManager) {
              try {
                const snapshot = { path: outcome.result.resolved_path, beforeContent, afterContent: outcome.result._bytes ?? content, tool: 'write' as const, call: undoCall };
                if (atomic) pendingUndo.push(snapshot);
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
            // Track for /changes session change view
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
                  if (atomic) {
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
                    // The repair replaces only the bytes this call wrote; a file changed during the repair is left alone.
                    const healedBytes = Buffer.from(healResult.content, 'utf-8');
                    const stamp = atomicWrite(resolvedPath, healResult.content, 'utf-8', known.get(resolvedPath)?.stamp);
                    known.set(resolvedPath, { bytes: healedBytes, stamp });
                    if (captured && (capturedAtomic || options.fileUndoManager)) revisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, healedBytes));
                    content = healResult.content;
                    outcome.result._content = content;
                    outcome.result.bytes_written = Buffer.byteLength(content, 'utf-8');
                    outcome.result.auto_heal = {
                      attempted: true,
                      healed: true,
                      method: healResult.method,
                    };
                  } catch (writeErr) {
                    if (atomic) return await rollbackAtomic(fileInput.path, `Auto-heal rewrite failed: ${summarizeError(writeErr)}`);
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
      // A file auto-heal rewrote no longer holds what the caller sent; say so whatever the verbosity.
      const healed = results.flatMap((r) => r.auto_heal?.healed ? [{ path: r.path, method: r.auto_heal.method ?? 'unknown' }] : []);
      if (healed.length > 0) {
        finalOutput.healed = healed;
        finalOutput.healed_notice = `Auto-heal repaired a syntax error and rewrote ${healed.length === 1 ? 'this file' : 'these files'}: the file on disk differs from the content you sent. Read it before editing.`;
      }
      if (errors.length > 0) {
        finalOutput.errors = errors;
        // count_only carries no file list; on a partial failure the model
        // still needs to know which files landed.
        if (!finalOutput.files) finalOutput.written_paths = results.map((result) => result.path);
      }

      // Post-write validation, run after all files are written, even if partial errors occurred
      let validationFailed: string | undefined;
      if (!dryRun && results.length > 0 && requestedValidators.length > 0) {
        const validatorNames = requestedValidators;
        logger.debug('write tool: running post-write validators', { validators: validatorNames });
        try {
          const failures = await runValidators(validatorNames, projectRoot, options.validatorRunner, assertCurrent, executeOptions?.signal,
            undefined, validatorSettings(options.configManager));
          if (failures.length > 0) {
            finalOutput.validation_failures = failures.map((f) => ({
              validator: f.validator,
              passed: false,
              exit_code: f.exitCode,
              ...(f.stderr.trim() ? { stderr: capValidatorOutput(f.stderr) } : {}),
              ...(f.stdout.trim() ? { stdout: capValidatorOutput(f.stdout) } : {}),
            }));
            logger.warn('write tool: post-write validators failed', {
              count: failures.length,
              validators: failures.map((f) => f.validator),
            });
            validationFailed = `Post-write validation failed for validator(s): ${failures.map((f) => f.validator).join(', ')}. The ${results.length} written file(s) were kept on disk, not rolled back; fix them or restore them yourself. The output is in validation_failures.`;
          } else {
            finalOutput.validation_passed = true;
          }
        } catch (validationErr) {
          const validationMessage = summarizeError(validationErr);
          logger.warn('write tool: validator execution error', { error: validationMessage });
          finalOutput.validation_error = validationMessage;
          validationFailed = `Post-write validation did not complete: ${validationMessage}. The ${results.length} written file(s) were kept on disk.`;
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
        success: errors.length === 0 && validationFailed === undefined,
        output: JSON.stringify(finalOutput),
        ...(errors.length > 0
          ? { error: `${errors.length} of ${input.files.length} file(s) failed; ${results.length} written. First failure: ${errors[0]}${validationFailed ? ` ${validationFailed}` : ''}` }
          : validationFailed ? { error: validationFailed } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}
