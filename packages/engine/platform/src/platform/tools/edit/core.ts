import { assertCurrentToolInvocation } from '../registry.js';
import { captureFileEffectRevision } from '../shared/file-effect-revision.js';
import type { CapturedWriteRevision } from '../shared/captured-write-revision.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Tool, ToolDefinition, ToolExecuteOptions, ToolHostEvidence } from '../../types/tools.js';
import { logger } from '../../utils/logger.js';
import type { SessionChangeTracker } from '../../sessions/change-tracker.js';
import { FileUndoManager } from '../../state/file-undo.js';
import { FileStateCache, unifiedDiff } from '../../state/file-cache.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { resolveWritablePath } from '../../utils/path-safety.js';
import { assertCapturedToolWriteRevision, captureCapturedToolWriteRevision, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';
import { editSchema } from './schema.js';
import { healToolFile, type CapturedAutoHealBackend } from '../shared/captured-auto-heal.js';
import {
  collectPostEditDiagnostics,
  formatDiagnosticsBlock,
  type DiagnosticsProvider,
} from '../shared/post-edit-diagnostics.js';
import { isImportGraphSource, latestProjectImportGraph } from '../../intelligence/import-graph.js';
import { announceWrites, recordPublishedEdit, verboseContent } from './publish.js';
import {
  buildFailedEditResult,
  computeAstEdit,
  computeAstPatternEdit,
  computeSingleEdit,
  type EditFailure,
  type EditFailureStatus,
} from './match.js';
import type { EditInput, EditItem, EditResult, ValidatorName } from './types.js';
import { executeNotebookEdit, occConflictMessage } from './notebook.js';
import { summarizeError } from '../../utils/error-display.js';
import { describeUnexpectedToolError } from '../input-projection.js';
import { toRecord } from '../../utils/record-coerce.js';
import {
  runValidators as runSharedValidators,
  formatValidatorFailure,
  describeUndeclaredValidators,
  undeclaredValidators,
  type ValidatorResult,
  type ValidatorRunner,
} from '../shared/validators.js';

const DIFF_TRUNCATE_THRESHOLD = 5000;
const DIFF_PREVIEW_LENGTH = 500;
/** Dependents named in the note after an edit; the rest are counted. */
const DEPENDENTS_NAMED = 5;

/** The edit tool's result; a failed call carries the matcher's status as host evidence for telemetry. */
export interface EditToolResult {
  success: boolean;
  output?: string;
  error?: string;
  hostEvidence?: ToolHostEvidence;
}

function failed(error: string, status: EditFailureStatus, output?: string): EditToolResult {
  return { success: false, error, ...(output !== undefined ? { output } : {}), hostEvidence: { editStatus: status } };
}


async function runValidators(validators: ValidatorName[], cwd: string, runner?: ValidatorRunner, assertCurrent?: () => void, signal?: AbortSignal): Promise<ValidatorResult | null> {
  const failures = await runSharedValidators(validators, cwd, runner, assertCurrent, signal);
  return failures[0] ?? null;
}

interface EditExecutionContext {
  readonly authenticated: boolean;
  readonly assertCurrent: () => void;
  readonly ownedRevisions: Map<string, () => void>;
  readonly initialRevisions: Map<string, () => void>;
  readonly signal?: AbortSignal | undefined;
  capturedRevisions: Map<string, CapturedWriteRevision>;
  capturedWritten: Set<string>;
  /** Paths this call wrote and has not rolled back (every mode). */
  written: Set<string>;
  fileCache: FileStateCache;
  cwd: string;
  fileUndoManager?: FileUndoManager | undefined;
  /** This call's undo token: every file it changes is one undo entry. */
  undoCall?: number | undefined;
  configManager?: Pick<ConfigManager, 'get' | 'getWorkingDirectory'> | undefined;
  toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
  diagnosticsProvider?: DiagnosticsProvider | undefined;
  validatorRunner?: ValidatorRunner | undefined;
  capturedAutoHeal?: CapturedAutoHealBackend | undefined;
}

interface ResolvedTextEditInput {
  resolvedPaths: Map<string, string>;
  fileContents: Map<string, string>;
  /** Why a path was refused (non-atomic modes only); such a path is never read. */
  pathErrors: Map<string, string>;
  fileReadErrors: Map<string, EditFailure>;
  workingContents: Map<string, string>;
}

interface PostValidationRepairResult {
  healed: boolean;
  healedPaths: Set<string>;
  warnings: string[];
}

async function prepareTextEditInput(
  input: EditInput,
  env: EditExecutionContext,
  transactionMode: 'atomic' | 'partial' | 'none',
): Promise<ResolvedTextEditInput | EditFailure> {
  const resolvedPaths: Map<string, string> = new Map();
  const pathErrors: Map<string, string> = new Map();
  for (const item of input.edits!) {
    if (resolvedPaths.has(item.path) || pathErrors.has(item.path)) continue;
    try {
      resolvedPaths.set(item.path, resolveWritablePath(item.path, env.cwd));
    } catch (err) {
      const msg = `Path error for '${item.path}': ${summarizeError(err)}`;
      if (transactionMode === 'atomic') {
        return { error: msg, status: 'failed' };
      }
      pathErrors.set(item.path, msg);
    }
  }

  // Only validated paths are read; a refused one is reported per edit and never touched.
  const uniquePaths = new Set(resolvedPaths.values());
  const fileContents: Map<string, string> = new Map();
  const fileReadErrors: Map<string, EditFailure> = new Map();

  for (const resolvedPath of uniquePaths) {
    await assertCapturedToolReadAccess(resolvedPath);
    let content: string;
    try {
      content = readFileSync(resolvedPath, 'utf-8');
    } catch {
      const msg = `File not found or unreadable: '${resolvedPath}'`;
      if (transactionMode === 'atomic') {
        return { error: msg, status: 'not_found' };
      }
      fileReadErrors.set(resolvedPath, { error: msg, status: 'not_found' });
      continue;
    }
    // The stale-file check compares the bytes this edit will change, read once.
    // A refused edit records nothing, so it keeps refusing until the file is read again.
    if (env.fileCache.compare(resolvedPath, content) === 'modified') {
      const msg = occConflictMessage(resolvedPath);
      if (transactionMode === 'atomic') {
        return { error: msg, status: 'conflict' };
      }
      fileReadErrors.set(resolvedPath, { error: msg, status: 'conflict' });
      continue;
    }
    try {
      if (env.authenticated && !input.dry_run) env.initialRevisions.set(resolvedPath, captureFileEffectRevision(resolvedPath, Buffer.from(content)));
      fileContents.set(resolvedPath, content);
      if (hasCapturedToolInvocation() && !input.dry_run) env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(content)));
    } catch (err) {
      // The file read fine; it is its kind (link, alias, encoding) that cannot be edited here.
      fileContents.delete(resolvedPath);
      const msg = `Cannot edit '${resolvedPath}': ${summarizeError(err)}. Nothing was changed; edit the link target or a plain UTF-8 file instead.`;
      if (transactionMode === 'atomic') {
        return { error: msg, status: 'failed' };
      }
      fileReadErrors.set(resolvedPath, { error: msg, status: 'failed' });
    }
  }

  return {
    resolvedPaths,
    pathErrors,
    fileContents,
    fileReadErrors,
    workingContents: new Map(fileContents),
  };
}

async function writeSuccessfulTextEdits(
  results: EditResult[],
  resolvedPaths: Map<string, string>,
  workingContents: Map<string, string>,
  env: EditExecutionContext,
  writtenPaths: Set<string>,
): Promise<void> {
  for (const r of results) {
    if (!r.success) continue;
    const resolvedPath = resolvedPaths.get(r.path);
    if (!resolvedPath || writtenPaths.has(resolvedPath)) continue;

    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined) continue;

    try {
      await assertCapturedToolReadAccess(resolvedPath);
      assertCapturedToolMutationCurrent(resolvedPath);
      env.assertCurrent();
      if (env.authenticated) env.initialRevisions.get(resolvedPath)!();
      if (hasCapturedToolInvocation()) {
        const revision = env.capturedRevisions.get(resolvedPath);
        if (!revision) throw new Error('Captured edit has no initial revision');
        assertCapturedToolWriteRevision(resolvedPath, revision);
        writeFileSync(resolvedPath, newContent, 'utf-8');
        env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(newContent)));
        env.capturedWritten.add(resolvedPath);
      }
      else if (env.authenticated) writeFileSync(resolvedPath, newContent, 'utf-8');
      else await writeFile(resolvedPath, newContent, 'utf-8');
      if (env.authenticated) env.ownedRevisions.set(resolvedPath, captureFileEffectRevision(resolvedPath, Buffer.from(newContent)));
      env.fileCache.update(resolvedPath, newContent);
      writtenPaths.add(resolvedPath);
      env.written.add(resolvedPath);
      // Undo snapshots and change records wait for the final outcome
      // (finalizeUncapturedBookkeeping, or the captured block of the caller's
      // finally), so a rollback leaves none.
    } catch (err) {
      const msg = `Write failed for '${resolvedPath}': ${summarizeError(err)}`;
      for (const res of results) {
        if (res.path === r.path) {
          res.success = false;
          res.error = msg;
        }
      }
    }
  }
}

/**
 * Names the files that import what this call wrote, nearest first, from the
 * one import graph per project root that find and repo-map share (patched for
 * this write, so no file is read here). Only source files have dependents; on
 * the first edit under a root the caller waits for that root's one build. It
 * never compiles or runs anything: a compiler picked up from the project would
 * run outside the exec tool's approval path.
 */
export async function describeEditDependents(
  cwd: string,
  writtenPaths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const sources = [...writtenPaths].filter(isImportGraphSource);
  if (sources.length === 0 || signal?.aborted) return undefined;
  try {
    const pending = latestProjectImportGraph(cwd);
    const graph = signal
      ? await new Promise<Awaited<typeof pending> | undefined>((resolve, reject) => {
          const onAbort = () => resolve(undefined);
          signal.addEventListener('abort', onAbort, { once: true });
          pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        })
      : await pending;
    if (!graph) return undefined;

    const written = new Set(sources);
    const direct = new Set<string>();
    for (const source of sources) for (const dependent of graph.findDependents(source)) if (!written.has(dependent)) direct.add(dependent);
    const transitive = new Set<string>();
    for (const source of sources) for (const dependent of graph.findTransitiveDependents(source)) if (!written.has(dependent)) transitive.add(dependent);
    if (transitive.size === 0) return undefined;

    // Name what the caller may read; a refused file is counted, never named.
    const named: string[] = [];
    for (const dependent of [...direct, ...[...transitive].filter((path) => !direct.has(path))]) {
      if (named.length >= DEPENDENTS_NAMED) break;
      try {
        await assertCapturedToolReadAccess(dependent);
        named.push(relative(cwd, dependent) || dependent);
      } catch {
        // Not readable by this call: left out of the names.
      }
    }
    const more = transitive.size - named.length;
    const names = named.length > 0 ? `: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '';
    const verify = hasCapturedToolInvocation()
      ? 'Automatic dependency diagnostics are unavailable for captured edits; use the contained exec build/test workflow to verify the change.'
      : 'They were not type-checked; verify with the project\'s type check or build through the exec tool.';
    return `\nDependents: ${direct.size} file(s) import what this edit changed, ${transitive.size} in all${names}. ${verify}`;
  } catch (err) {
    logger.warn('[import-graph] Dependents lookup failed', { error: summarizeError(err) });
    return undefined;
  }
}

async function restoreOriginalContents(fileContents: Map<string, string>, env: EditExecutionContext): Promise<string[]> {
  const failures: string[] = [];
  const restored = new Set<string>();
  try {
    await restoreEach(fileContents, env, failures, restored);
  } finally {
    if (restored.size > 0) announceWrites(restored, fileContents);
  }
  return failures;
}

async function restoreEach(fileContents: Map<string, string>, env: EditExecutionContext, failures: string[], restored: Set<string>): Promise<void> {
  for (const [resolvedPath, originalContent] of fileContents) {
    try {
      if (env.authenticated && !env.ownedRevisions.has(resolvedPath)) continue;
      if (!env.authenticated && !hasCapturedToolInvocation() && !env.written.has(resolvedPath)) continue;
      await assertCapturedToolReadAccess(resolvedPath);
      assertCapturedToolMutationCurrent(resolvedPath);
      if (env.authenticated) env.ownedRevisions.get(resolvedPath)!();
      if (hasCapturedToolInvocation()) {
        if (!env.capturedWritten.has(resolvedPath)) continue;
        const revision = env.capturedRevisions.get(resolvedPath);
        if (!revision) throw new Error('Captured rollback has no owned revision');
        assertCapturedToolWriteRevision(resolvedPath, revision);
        writeFileSync(resolvedPath, originalContent, 'utf-8');
        env.capturedWritten.delete(resolvedPath);
      }
      else if (env.authenticated) writeFileSync(resolvedPath, originalContent, 'utf-8');
      else await writeFile(resolvedPath, originalContent, 'utf-8');
      env.ownedRevisions.delete(resolvedPath);
      env.written.delete(resolvedPath);
      env.fileCache.update(resolvedPath, originalContent);
      restored.add(resolvedPath);
    } catch (error) {
      failures.push(`Rollback held for '${resolvedPath}': ${summarizeError(error)}`);
    }
  }
}

async function repairAfterValidationFailure(
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  failureMessages: string[],
  env: EditExecutionContext,
): Promise<PostValidationRepairResult> {
  let healed = false;
  const healedPaths = new Set<string>();
  const warnings: string[] = [];
  for (const [resolvedPath, originalContent] of fileContents) {
    if (hasCapturedToolInvocation() && !env.capturedWritten.has(resolvedPath)) continue;
    if (env.authenticated && !env.ownedRevisions.has(resolvedPath)) continue;
    env.assertCurrent();
    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined || newContent === originalContent) continue;
    const healResult =
      env.configManager && env.toolLLM
        ? await healToolFile(env.configManager, env.toolLLM, resolvedPath, newContent, failureMessages, env.capturedAutoHeal, env.authenticated ? env.assertCurrent : undefined, env.signal)
        : { healed: false, content: newContent, assertCurrent: async () => {}, assertCurrentSynchronous: () => {}, warnings: undefined };
    warnings.push(...(healResult.warnings ?? []));
    if (healResult.healed) {
      try {
        if (hasCapturedToolInvocation()) {
          await healResult.assertCurrent();
          healResult.assertCurrentSynchronous();
          assertCapturedToolMutationCurrent(resolvedPath);
        }
        env.assertCurrent();
        if (env.authenticated) env.ownedRevisions.get(resolvedPath)!();
        writeFileSync(resolvedPath, healResult.content, 'utf-8');
        if (env.authenticated) env.ownedRevisions.set(resolvedPath, captureFileEffectRevision(resolvedPath, Buffer.from(healResult.content)));
        workingContents.set(resolvedPath, healResult.content);
        if (hasCapturedToolInvocation()) {
          env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(healResult.content)));
        }
        env.fileCache.update(resolvedPath, healResult.content);
        announceWrites([resolvedPath], workingContents);
        healed = true;
        healedPaths.add(resolvedPath);
      } catch {
        // Leave validation failure handling to the caller if the heal write fails.
      }
    }
  }
  return { healed, healedPaths, warnings };
}

async function validateAfterTextEdits(
  validators: ValidatorName[],
  cwd: string,
  transactionMode: 'atomic' | 'partial' | 'none',
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  env: EditExecutionContext,
): Promise<{ error?: string; warnings?: string[]; healedPaths?: ReadonlySet<string> }> {
  try {
    const failure = await runValidators(validators, cwd, env.validatorRunner, env.assertCurrent, env.signal);
    if (!failure) return {};

    const failureMessages = [formatValidatorFailure(failure)];
    const repair = await repairAfterValidationFailure(fileContents, workingContents, failureMessages, env);
    if (repair.healed) {
      const healFailure = await runValidators(validators, cwd, env.validatorRunner, env.assertCurrent, env.signal);
      if (!healFailure) {
        return { warnings: repair.warnings, healedPaths: repair.healedPaths };
      }
    }

    const rollbackFailures = transactionMode === 'atomic' ? await restoreOriginalContents(fileContents, env) : [];
    return {
      warnings: [...repair.warnings, ...rollbackFailures],
      healedPaths: repair.healedPaths,
      error: `Post-edit validation failed${transactionMode === 'atomic' ? (rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back') : remainingEditsNote(env)}. ${formatValidatorFailure(failure)}`,
    };
  } catch (error) {
    if (transactionMode !== 'atomic') {
      return { error: `Post-edit validation or repair failed${remainingEditsNote(env)}. ${summarizeError(error)}` };
    }
    const rollbackFailures = await restoreOriginalContents(fileContents, env);
    return {
      error: `Post-edit validation or repair failed${rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back'}. ${summarizeError(error)}`,
      warnings: rollbackFailures,
    };
  }
}

/** For a non-atomic failure: which files still hold this call's edits. */
function remainingEditsNote(env: EditExecutionContext): string {
  return env.written.size > 0 ? `; edits remain applied to: ${[...env.written].join(', ')}` : '';
}

/**
 * Undo snapshots and change records for uncaptured edits, made once the
 * outcome is final so a rolled-back file leaves neither behind.
 */
function finalizeUncapturedBookkeeping(
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  env: EditExecutionContext,
): void {
  for (const path of env.written) {
    const afterContent = workingContents.get(path);
    if (afterContent === undefined) continue;
    recordPublishedEdit(env, path, fileContents.get(path) ?? null, afterContent);
  }
}

function formatOutput(
  results: EditResult[],
  format: 'count_only' | 'minimal' | 'with_diff' | 'verbose',
  dryRun: boolean,
  notes: readonly string[] = [],
  contents: readonly { readonly path: string; readonly before: string; readonly after: string }[] = [],
): string {
  const totalApplied = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;
  const dryTag = dryRun ? ' (dry run)' : '';

  if (format === 'count_only') {
    // Counts alone leave the model guessing which edit failed, so name each failure.
    const failedEdits = results.filter((r) => !r.success)
      .map((r) => ({ path: r.path, ...(r.id !== undefined ? { id: r.id } : {}), status: r.status ?? 'failed', ...(r.error !== undefined ? { error: r.error } : {}) }));
    // Notes stay inside the JSON: text after it would make the whole output unparseable.
    const trimmed = notes.map((note) => note.trim()).filter(Boolean);
    return JSON.stringify({
      applied: totalApplied, failed: totalFailed, dry_run: dryRun,
      ...(failedEdits.length > 0 ? { failed_edits: failedEdits } : {}),
      ...(trimmed.length > 0 ? { notes: trimmed } : {}),
    });
  }

  const lines: string[] = [];
  lines.push(`Edits applied: ${totalApplied}, failed: ${totalFailed}${dryTag}`);

  if (format === 'minimal') {
    for (const r of results) {
      if (r.success) {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  OK${statusTag}${id}: ${r.path} (${r.occurrencesReplaced} replacement(s))`);
        if (r.warning) {
          lines.push(`    WARN: ${r.warning}`);
        }
      } else {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  FAIL${statusTag}${id}: ${r.path}, ${r.error}`);
        if (r.hint) {
          lines.push(`    HINT: ${r.hint}`);
        }
      }
    }
    return lines.join('\n');
  }

  for (const r of results) {
    const id = r.id ? ` [${r.id}]` : '';
    if (r.success) {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} (${r.occurrencesReplaced} replacement(s))${dryTag} ---`);
      if (r.diff) {
        if (r.diff_truncated) {
          lines.push(`[diff truncated, showing first ${DIFF_PREVIEW_LENGTH} chars]`);
          lines.push(r.diff_preview ?? r.diff.slice(0, DIFF_PREVIEW_LENGTH));
        } else {
          lines.push(r.diff);
        }
      }
      if (r.warning) {
        lines.push(`  WARN: ${r.warning}`);
      }
    } else {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} FAILED ---`);
      lines.push(`  Error: ${r.error}`);
      if (r.hint) {
        lines.push(`  Hint: ${r.hint}`);
      }
    }
  }
  if (format === 'verbose') {
    for (const file of contents) {
      lines.push(`\n=== ${file.path} before ===`, verboseContent(file.before), `=== ${file.path} after${dryRun ? ' (dry run, not written)' : ''} ===`, verboseContent(file.after));
    }
  }
  return lines.join('\n');
}

async function executeTextEdits(
  input: EditInput,
  env: EditExecutionContext,
): Promise<EditToolResult> {
  const matchMode = input.match?.mode ?? 'exact';
  const caseSensitive = input.match?.case_sensitive ?? true;
  const whitespaceSensitive = input.match?.whitespace_sensitive ?? true;
  const multiline = input.match?.multiline ?? false;
  // `none` is the older name of `partial`: both apply what succeeds and keep it.
  const transactionMode = input.transaction?.mode === 'none' ? 'partial' : (input.transaction?.mode ?? 'atomic');
  const outputFormat = input.output?.format ?? 'minimal';
  const diffContext = input.output?.diff_context ?? 3;
  const dryRun = input.dry_run ?? false;
  const validateBefore = input.validate?.before ?? [];
  const validateAfter = input.validate?.after ?? [];
  const cwd = env.cwd;

  if ((validateBefore.length > 0 || validateAfter.length > 0) && !env.validatorRunner) {
    return failed(`validate is not available in this session: it has no exec path to run validators through. Nothing was changed; resend without validate and run the check with the exec tool.`, 'failed');
  }
  if (!dryRun && (validateBefore.length > 0 || validateAfter.length > 0)) {
    const missing = undeclaredValidators([...new Set([...validateBefore, ...validateAfter])], cwd);
    if (missing.length > 0) return failed(describeUndeclaredValidators(missing, cwd), 'failed');
  }

  if (!dryRun && validateBefore.length > 0) {
    const failure = await runValidators(validateBefore, cwd, env.validatorRunner, env.assertCurrent, env.signal);
    if (failure) {
      return failed(`Pre-edit validation failed. ${formatValidatorFailure(failure)}`, 'failed');
    }
  }

  const prepResult = await prepareTextEditInput(input, env, transactionMode);
  if ('error' in prepResult) {
    return failed(prepResult.error, prepResult.status);
  }

  const { resolvedPaths, pathErrors, fileContents, fileReadErrors, workingContents } = prepResult;
  const results: EditResult[] = [];
  let atomicFailed = false;
  let atomicFailError = '';
  let atomicFailStatus: EditFailureStatus = 'failed';

  for (const item of input.edits!) {
    const resolvedPath = resolvedPaths.get(item.path);

    if (!resolvedPath) {
      const pathMsg = pathErrors.get(item.path) ?? `Path resolution failed for '${item.path}'`;
      results.push(buildFailedEditResult(item, pathMsg, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = pathMsg;
        atomicFailStatus = 'failed';
        break;
      }
      continue;
    }

    const readError = fileReadErrors.get(resolvedPath);
    if (readError) {
      results.push(buildFailedEditResult(item, readError.error, readError.status));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = readError.error;
        atomicFailStatus = readError.status;
        break;
      }
      continue;
    }

    const currentContent = workingContents.get(resolvedPath);
    if (currentContent === undefined) {
      results.push(buildFailedEditResult(item, `No content available for '${resolvedPath}'`, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = `No content available for '${resolvedPath}'`;
        atomicFailStatus = 'failed';
        break;
      }
      continue;
    }

    let editResult:
      | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
      | EditFailure;
    if (matchMode === 'ast_pattern') {
      editResult = await computeAstPatternEdit(currentContent, item, resolvedPath);
    } else if (matchMode === 'ast') {
      editResult = await computeAstEdit(currentContent, item, resolvedPath);
    } else {
      editResult = await computeSingleEdit(
        currentContent,
        item,
        matchMode,
        caseSensitive,
        whitespaceSensitive,
        multiline,
        { signal: env.signal, assertCurrent: env.assertCurrent },
      );
    }

    if ('error' in editResult) {
      const errMsg = editResult.error;
      results.push({
        ...buildFailedEditResult(item, errMsg, editResult.status),
        hint: editResult.hint,
      });
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = errMsg;
        atomicFailStatus = editResult.status;
        break;
      }
      continue;
    }

    const oldContent = currentContent;
    workingContents.set(resolvedPath, editResult.newContent);

    let diff: string | undefined;
    let diffTruncated: boolean | undefined;
    let diffPreview: string | undefined;
    if (outputFormat === 'with_diff' || outputFormat === 'verbose' || dryRun) {
      const rawDiff = unifiedDiff(oldContent, editResult.newContent, resolvedPath, diffContext);
      // Verbose promises full detail, so its diff is never cut.
      if (outputFormat !== 'verbose' && rawDiff.length > DIFF_TRUNCATE_THRESHOLD) {
        diffTruncated = true;
        diffPreview = rawDiff.slice(0, DIFF_PREVIEW_LENGTH);
        diff = diffPreview;
      } else {
        diff = rawDiff;
      }
    }
    results.push({
      id: item.id,
      path: item.path,
      success: true,
      status: 'applied',
      occurrencesReplaced: editResult.occurrencesReplaced,
      diff,
      diff_truncated: diffTruncated,
      diff_preview: diffPreview,
      warning: editResult.warning,
    });
  }

  if (transactionMode === 'atomic' && atomicFailed) {
    const atomicResults: EditResult[] = (input.edits ?? []).map((item, idx) => {
      const r = results[idx]!;
      if (r && !r.success) return r;
      return {
        id: item.id,
        path: item.path,
        success: false,
        status: 'failed',
        error: r?.success ? 'Rolled back due to atomic transaction failure' : (r?.error ?? atomicFailError),
      };
    });
    return failed(`Atomic transaction failed: ${atomicFailError}`, atomicFailStatus, formatOutput(atomicResults, outputFormat, dryRun));
  }

  const writtenPaths = new Set<string>();
  try {
    if (!dryRun) {
      try {
        await writeSuccessfulTextEdits(results, resolvedPaths, workingContents, env, writtenPaths);
      } finally {
        announceWrites(writtenPaths, workingContents);
      }
      if (transactionMode === 'atomic' && results.some((result) => !result.success)) {
        const rollbackFailures = await restoreOriginalContents(fileContents, env);
        return failed(`Atomic edit publication failed${rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back'}. ${results.filter((result) => !result.success).map((result) => result.error).join('; ')}${rollbackFailures.length ? `\n${rollbackFailures.join('\n')}` : ''}`, 'failed');
      }
    }

    const anySuccess = results.some((r) => r.success);

    let importGraphWarning: string | undefined;
    if (!dryRun && anySuccess) {
      importGraphWarning = await describeEditDependents(cwd, writtenPaths, env.signal);
    }

    let repairWarnings: string[] = [];
    if (!dryRun && anySuccess && validateAfter.length > 0) {
      const validationResult = await validateAfterTextEdits(
        validateAfter,
        cwd,
        transactionMode,
        fileContents,
        workingContents,
        env,
      );
      repairWarnings = validationResult.warnings ?? [];
      if (hasCapturedToolInvocation() && validationResult.healedPaths?.size) {
        for (const result of results) {
          const path = resolvedPaths.get(result.path);
          if (!result.success || !path || !writtenPaths.has(path) || !validationResult.healedPaths.has(path)) continue;
          result.warning = [result.warning, 'Auto-heal applied; diff reflects the final repaired content.'].filter(Boolean).join(' ');
          if (outputFormat === 'with_diff' || outputFormat === 'verbose') {
            const diff = unifiedDiff(fileContents.get(path) ?? '', workingContents.get(path) ?? '', path, diffContext);
            result.diff_truncated = outputFormat !== 'verbose' && diff.length > DIFF_TRUNCATE_THRESHOLD;
            result.diff = result.diff_truncated ? diff.slice(0, DIFF_PREVIEW_LENGTH) : diff;
            result.diff_preview = result.diff_truncated ? result.diff : undefined;
          }
        }
      }
      if (validationResult.healedPaths?.size) {
        for (const result of results) {
          const path = resolvedPaths.get(result.path);
          if (!result.success || !path || !validationResult.healedPaths.has(path) || hasCapturedToolInvocation()) continue;
          result.warning = [result.warning, 'Auto-heal applied; the file now holds the repaired content, not exactly your replacement.'].filter(Boolean).join(' ');
        }
      }
      if (validationResult.error) {
        return failed(
          validationResult.error + (repairWarnings.length ? `\n${repairWarnings.join('\n')}` : ''),
          'failed',
          transactionMode === 'atomic' ? undefined : formatOutput(results, outputFormat, dryRun),
        );
      }
    }

    // Post-edit diagnostics, cheap, in-process syntax check of each file we just
    // wrote, appended as a text block (this output already carries text suffixes
    // like the import-graph warning). Off when configured off; empty block when
    // the provider finds nothing (honest absence).
    let diagnosticsBlock = '';
    if (
      !dryRun &&
      writtenPaths.size > 0 &&
      env.diagnosticsProvider &&
      (env.configManager?.get('diagnostics.postEdit') ?? 'on') === 'on'
    ) {
      const touched = [...writtenPaths]
        .map((path) => ({ path, content: workingContents.get(path) }))
        .filter((f): f is { path: string; content: string } => typeof f.content === 'string');
      diagnosticsBlock = formatDiagnosticsBlock(await collectPostEditDiagnostics(env.diagnosticsProvider, touched));
    }

    const failures = results.filter((r) => !r.success);
    const contents = outputFormat === 'verbose'
      ? [...new Set(results.filter((r) => r.success).map((r) => resolvedPaths.get(r.path)).filter((path): path is string => path !== undefined))]
        .map((path) => ({ path, before: fileContents.get(path) ?? '', after: workingContents.get(path) ?? '' }))
      : [];
    const output = outputFormat === 'count_only'
      ? formatOutput(results, outputFormat, dryRun, [importGraphWarning ?? '', ...repairWarnings, diagnosticsBlock])
      : formatOutput(results, outputFormat, dryRun, [], contents) + (importGraphWarning ?? '') + (repairWarnings.length ? `\n${repairWarnings.join('\n')}` : '') + diagnosticsBlock;
    if (!anySuccess && failures.length > 0) {
      const first = failures[0]!;
      return failed(`No edits applied (${failures.length} failed). First failure: ${first.path}: ${first.error ?? 'failed'}`, first.status === 'applied' || first.status === undefined ? 'failed' : first.status, output);
    }
    return { success: anySuccess, output };
  } finally {
    if (!dryRun && !hasCapturedToolInvocation()) finalizeUncapturedBookkeeping(fileContents, workingContents, env);
    // Captured writes still held after any rollback are the final changes.
    if (!dryRun && hasCapturedToolInvocation()) {
      for (const path of env.capturedWritten) env.changeTracker?.recordChange(path);
    }
    // A failed validator/repair can leave successful edits in place. Finalize
    // only revisions we still own; rollback, revocation and a newer writer must
    // never create an executable snapshot of stale or unauthorized contents.
    if (!dryRun && hasCapturedToolInvocation() && env.fileUndoManager) {
      const admitted: Array<{ path: string; content: string; revision: CapturedWriteRevision }> = [];
      for (const path of env.capturedWritten) {
        const content = workingContents.get(path);
        const revision = env.capturedRevisions.get(path);
        if (content === undefined || !revision) continue;
        try {
          await assertCapturedToolReadAccess(path);
          admitted.push({ path, content, revision });
        } catch {
          // A later denial can invalidate earlier admissions too. Preserve the
          // prior history rather than grant delayed authority to any of them.
          admitted.length = 0;
          break;
        }
      }
      // A later admission can change an earlier file. Fence every revision after
      // all policy awaits, then snapshot synchronously under the same lease.
      for (const { path, content, revision } of admitted) {
        try {
          assertCapturedToolWriteRevision(path, revision);
          env.fileUndoManager.snapshot({ path, beforeContent: fileContents.get(path) ?? null, afterContent: content, tool: 'edit', call: env.undoCall });
        } catch {
          // Bookkeeping must not hide the edit result or bypass a held revision.
        }
      }
    }
  }
}

export interface EditToolOptions {
  cwd?: string | undefined;
  fileUndoManager?: FileUndoManager | undefined;
  configManager?: Pick<ConfigManager, 'get' | 'getWorkingDirectory'> | undefined;
  toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
  diagnosticsProvider?: DiagnosticsProvider | undefined;
  validatorRunner?: ValidatorRunner | undefined;
  capturedAutoHeal?: CapturedAutoHealBackend | undefined;
}

function resolveEditCwd(options?: EditToolOptions): string {
  if (options?.cwd && options.cwd.trim().length > 0) {
    return options.cwd;
  }
  const workingDirectory = options?.configManager?.getWorkingDirectory();
  if (workingDirectory && workingDirectory.trim().length > 0) {
    return workingDirectory;
  }
  throw new Error('createEditTool requires an explicit cwd or configManager.getWorkingDirectory()');
}

export function createEditTool(fileCache: FileStateCache, options?: EditToolOptions): Tool {
  const cwd = resolveEditCwd(options);
  const definition: ToolDefinition = {
    name: 'edit',
    // Sent in full on every model request (see ToolDefinition.core).
    core: true,
    description:
      'Edit files by finding and replacing text. Supports exact, fuzzy, and regex matching. ' +
      'Handles multiple edits in one call with atomic or partial transaction semantics. ' +
      'Read a file before editing it: an edit is refused (OCC conflict) when the file changed since your last read, and stays refused until you read it again. ' +
      'Also supports Jupyter notebook (.ipynb) cell operations via notebook_operations field.',
    parameters: toRecord(editSchema),
    sideEffects: ['write_fs'],
    subjects: { paths: ['edits[].path', 'notebook_operations.path'] },
    // A call that runs validators runs commands, which undo cannot take back: the gate does not wave it through as a recoverable write.
    ...(options?.fileUndoManager ? { recoverable: { unless: ['validate.before[]', 'validate.after[]'] } } : {}),
    concurrency: 'serial',
    supportsProgress: true,
  };

  async function execute(
    args: Record<string, unknown>,
    executeOptions?: ToolExecuteOptions,
  ): Promise<EditToolResult> {
    try {
      const authenticated = assertCurrentToolInvocation(args, executeOptions);
      const assertCurrent = () => { assertCurrentToolInvocation(args, executeOptions); };
      const input = args as EditInput;
      if (!input.edits && !input.notebook_operations) {
        return { success: false, error: 'Either edits or notebook_operations must be provided' };
      }
      if (input.edits && input.notebook_operations) {
        return { success: false, error: 'Provide either edits or notebook_operations, not both' };
      }

      const env: EditExecutionContext = {
        authenticated, assertCurrent, ownedRevisions: new Map(), initialRevisions: new Map(), signal: executeOptions?.signal,
        capturedRevisions: new Map(),
        capturedWritten: new Set(),
        written: new Set(),
        fileCache,
        cwd,
        fileUndoManager: options?.fileUndoManager,
        undoCall: options?.fileUndoManager?.beginCall(),
        configManager: options?.configManager,
        toolLLM: options?.toolLLM,
        changeTracker: options?.changeTracker,
        diagnosticsProvider: options?.diagnosticsProvider,
        validatorRunner: options?.validatorRunner,
        capturedAutoHeal: options?.capturedAutoHeal,
      };

      if (input.notebook_operations) {
        // These fields shape text edits only. Accepting them silently would let
        // the model believe a validator ran or a transaction mode applied.
        const ignored = (['validate', 'match', 'transaction'] as const).filter((field) => input[field] !== undefined);
        if (ignored.length > 0) {
          return { success: false, error: `notebook_operations does not support ${ignored.join(', ')}. Nothing was changed; resend without ${ignored.length > 1 ? 'them' : 'it'}, and run any validator separately.` };
        }
        return await executeNotebookEdit(input, env);
      }
      return await executeTextEdits(input, env);
    } catch (err) {
      return { success: false, error: describeUnexpectedToolError(err, summarizeError) };
    }
  }

  return { definition, execute };
}
