import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CEILING_TOKENS } from '../../runtime/tools/output-policy.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import type { Tool, ToolDefinition, ToolExecuteOptions, ToolHostEvidence } from '../../types/tools.js';
import { readExecutionGuard } from './admission.js';
import { READ_TOOL_SCHEMA } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';
import type { ReadInput, ReadFileInput, ExtractMode, OutputFormat } from './schema.js';
import { FileStateCache } from '../../state/file-cache.js';
import { ProjectIndex } from '../../state/project-index.js';
import { CodeIntelligence } from '../../intelligence/facade.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { describeUnexpectedToolError } from '../input-projection.js';
import {
  paginateFiles,
  readOneFile,
  type FileReadResult,
  type ReadOutput,
} from './file-readers.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { clipReadContent } from './observation.js';
import type { tryLoadSharp } from './media.js';

export type { FileReadResult, ReadOutput } from './file-readers.js';

const MAX_PARALLEL_READ_FILES = 8;
/** Response cap when the caller sets neither output.max_tokens nor token_budget. */
export const DEFAULT_READ_MAX_TOKENS = DEFAULT_CEILING_TOKENS.read;
/** Calls at least this slow report their wall time. */
const SLOW_READ_MS = 2_000;

export class ReadTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'read',
    description:
      'Read one or more files from disk. Supports extract modes (content, outline, symbols, lines, ast)'
      + ' for token-efficient reading, per-file caching, pagination via token_budget, and batch processing.',
    parameters: toRecord(READ_TOOL_SCHEMA),
    sideEffects: ['read_fs'],
    subjects: { paths: ['files[].path'] },
    concurrency: 'parallel',
    supportsProgress: true,
  };

  private readonly fileCache: FileStateCache;
  private readonly projectIndex: ProjectIndex;
  private readonly codeIntelligence: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>;

  constructor(
    projectIndex: ProjectIndex,
    fileCache?: FileStateCache,
    codeIntelligence?: Pick<CodeIntelligence, 'getOutline' | 'getSymbols'>,
    private readonly capturedReadAccess?: ReadAccessFilter | undefined,
    private readonly allowOutsideProject: () => boolean = () => false,
    /** The owner's standing page budget (`tools.defaultTokenBudget`), read per call; applies only when the call sets no `token_budget`. 0 or unset means none. */
    private readonly defaultTokenBudget: () => number | undefined = () => undefined,
    /** Image-library loader for resizing; defaults to the lazy sharp import. */
    private readonly loadSharp?: typeof tryLoadSharp,
  ) {
    this.fileCache = fileCache ?? new FileStateCache();
    this.projectIndex = projectIndex;
    this.codeIntelligence = codeIntelligence ?? new CodeIntelligence({});
  }

  async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string; hostEvidence?: ToolHostEvidence }> {
    if (!Array.isArray(args.files) || args.files.length === 0) {
      return { success: false, error: 'Missing or empty "files" array' };
    }
    try {
      const guard = readExecutionGuard(args, options, this.projectIndex);
      const allowOutsideProject = this.allowOutsideProject();
      const assertCurrent = () => {
        guard();
        if (this.allowOutsideProject() !== allowOutsideProject) throw new Error('Read permission mode changed');
      };
      assertCurrent();
      const result = await this._execute(args as unknown as ReadInput, assertCurrent, allowOutsideProject);
      assertCurrent();
      return result;
    } catch (err) {
      const message = summarizeError(err);
      logger.error('read tool: unexpected error', { error: message });
      return { success: false, error: describeUnexpectedToolError(err, summarizeError) };
    }
  }

  /** A link inside the project is judged by where it leads as well as by its own name. */
  private async readAllowed(access: ReadAccessFilter, lexicalPath: string): Promise<boolean> {
    if (!await access(lexicalPath)) return false;
    let real: string;
    try {
      real = realpathSync(lexicalPath);
    } catch {
      return true; // Not an existing path: the read itself reports that.
    }
    return real === lexicalPath || access(real);
  }

  private async _execute(input: ReadInput, assertCurrent: () => void, allowOutsideProject: boolean): Promise<{ success: boolean; output: string; error?: string; hostEvidence?: ToolHostEvidence }> {
    const globalExtract: ExtractMode = input.extract ?? 'content';
    const format: OutputFormat = input.output?.format ?? 'standard';
    const includeLineNumbers: boolean = input.output?.include_line_numbers ?? true;
    const maxPerItem: number | undefined = input.output?.max_per_item;
    const standingBudget = this.defaultTokenBudget();
    const tokenBudget: number | undefined = input.token_budget
      ?? (typeof standingBudget === 'number' && Number.isFinite(standingBudget) && standingBudget >= 1 ? Math.floor(standingBudget) : undefined);
    // Without an explicit cap a single read is still bounded; what is cut is
    // listed in summary.truncated with the line to continue from.
    const maxTokens: number | undefined = input.output?.max_tokens ?? (tokenBudget === undefined ? DEFAULT_READ_MAX_TOKENS : undefined);
    const page: number = Math.max(1, input.page ?? 1);
    const globalImageMode = input.image_mode;
    const globalMaxImageSize = input.max_image_size;
    const startedAt = performance.now();

    const allFiles = input.files;
    let filesToProcess: ReadFileInput[] = allFiles;
    let paginationInfo: ReadOutput['pagination'] | undefined;

    if (tokenBudget === undefined && page > 1) {
      return { success: false, output: '', error: `page ${page} was requested without token_budget; pages exist only when token_budget splits the files. Omit page or pass token_budget.` };
    }
    if (tokenBudget !== undefined) {
      assertCurrent();
      const pages = paginateFiles(allFiles, tokenBudget, this.projectIndex.baseDir, allowOutsideProject);
      const totalPages = Math.max(1, pages.length);
      if (page > totalPages) {
        return { success: false, output: '', error: `page ${page} is past the last page: this batch has ${totalPages} page${totalPages === 1 ? '' : 's'} at token_budget ${tokenBudget}. Nothing was read.` };
      }
      const pageIdx = page - 1;
      const pageIndices = pages[pageIdx]! ?? [];

      filesToProcess = pageIndices.map((i) => allFiles[i]).filter((f): f is (typeof allFiles)[number] => f !== undefined);

      const deliveredSet = new Set(pages.slice(0, pageIdx + 1).flat());
      const pendingFiles = allFiles
        .map((f, i) => ({ f, i }))
        .filter(({ i }) => !deliveredSet.has(i))
        .map(({ f }) => f.path);

      paginationInfo = { page, total_pages: totalPages, pending_files: pendingFiles };
    }

    const results: FileReadResult[] = await mapWithConcurrency(
      filesToProcess,
      MAX_PARALLEL_READ_FILES,
      async (f) => {
        assertCurrent();
        if (this.capturedReadAccess && !await this.readAllowed(this.capturedReadAccess, resolve(this.projectIndex.baseDir, f.path))) {
          // One restricted path is that file's failure, not the whole batch's.
          return { path: f.path, resolvedPath: resolve(this.projectIndex.baseDir, f.path), lineCount: 0, byteSize: 0, tokenEstimate: 0,
            extract: f.extract ?? globalExtract,
            error: 'Access restricted: this path is outside what this work may read. Do not retry it; read only assigned files.' } satisfies FileReadResult;
        }
        assertCurrent();
        const result = await readOneFile(
          f,
          globalExtract,
          format,
          includeLineNumbers,
          maxPerItem,
          this.fileCache,
          this.projectIndex,
          globalImageMode,
          globalMaxImageSize,
          this.codeIntelligence,
          assertCurrent,
          allowOutsideProject,
          this.loadSharp,
        );
        assertCurrent();
        return result;
      },
    );
    assertCurrent();

    const clipped = new Set<FileReadResult>();
    if (maxTokens !== undefined) {
      let usedTokens = 0;
      for (const r of results) {
        if (r.content === undefined) continue;
        const contentTokens = Math.ceil(r.content.length / 4);
        if (usedTokens + contentTokens > maxTokens) {
          const remaining = Math.max(0, maxTokens - usedTokens);
          clipReadContent(r, remaining * 4);
          clipped.add(r);
        }
        usedTokens += Math.ceil((r.content?.length ?? 0) / 4);
      }
    }
    const truncated = results.flatMap((r, index) => {
      const observation = r.readObservation;
      if (!observation) return [];
      const range = filesToProcess[index]?.range;
      const requestedEnd = Math.min(r.lineCount, range?.end ?? r.lineCount);
      const nextStart = observation.startLine + observation.completeLines;
      if (nextStart > requestedEnd && !observation.truncated) return [];
      return [{ path: r.path, returned_lines: observation.completeLines, next_start_line: nextStart,
        reason: clipped.has(r) ? 'max_tokens' as const : 'max_per_item' as const }];
    });

    const images: NonNullable<ReadOutput['images']> = [];
    const fileResults: FileReadResult[] = results.map((r) => {
      if (r.imageData) {
        images.push({
          path: r.path,
          base64: r.imageData.base64,
          mediaType: r.imageData.mediaType,
          description: r.content ?? `Image: ${r.path}`,
        });
        const { imageData: _imageData, ...rest } = r;
        return rest;
      }
      return r;
    });

    const filesBinary = fileResults.filter((r) => r.binary === true).length;
    const filesErrored = fileResults.filter((r) => r.error !== undefined && !r.binary).length;
    const filesRead = fileResults.length - filesBinary - filesErrored;
    const totalLines = fileResults.reduce((s, r) => s + r.lineCount, 0);
    const totalTokens = fileResults.reduce((s, r) => s + r.tokenEstimate, 0);
    const returnedTokens = fileResults.reduce((s, r) => s + Math.ceil((r.content?.length ?? 0) / 4), 0);
    const elapsedMs = Math.round(performance.now() - startedAt);
    // Every requested read failing is a failed operation, never a green check
    // with zero lines. Per-file diagnostics stay in the structured output.
    const allFailed = fileResults.length > 0 && filesRead === 0 && filesBinary === 0;

    const output: ReadOutput = {
      success: !allFailed,
      summary: {
        files_read: filesRead,
        files_binary: filesBinary,
        files_errored: filesErrored,
        total_lines: totalLines,
        total_tokens: totalTokens,
        source_tokens: totalTokens,
        returned_tokens: returnedTokens,
        ...(truncated.length > 0 ? { truncated } : {}),
        ...(elapsedMs >= SLOW_READ_MS ? { elapsed_ms: elapsedMs } : {}),
      },
      ...(images.length > 0 ? { images } : {}),
    };

    if (format === 'count_only') {
      // summary only
    } else if (format === 'minimal') {
      output.files = fileResults.map((r) => ({
        path: r.path,
        lineCount: r.lineCount,
        byteSize: r.byteSize,
        tokenEstimate: r.tokenEstimate,
        extract: r.extract,
        binary: r.binary,
        error: r.error,
        cache: r.cache,
      }));
    } else if (format === 'verbose') {
      output.files = fileResults;
    } else if (format === 'standard') {
      // Per-file token estimates are bookkeeping (summary.source_tokens carries the total), and the
      // observation and resolved path are host facts that travel on `hostEvidence`, not in model text.
      output.files = fileResults.map(({ tokenEstimate: _tokenEstimate, readObservation: _observation, resolvedPath: _resolved, ...file }) => file);
    }

    if (paginationInfo) {
      output.pagination = paginationInfo;
    }

    const reads = fileResults.flatMap((r, index) => r.readObservation || r.resolvedPath
      ? [{ index, path: r.path, resolvedPath: r.resolvedPath, readObservation: r.readObservation ? { ...r.readObservation } : undefined }]
      : []);
    const hostEvidence = reads.length ? { hostEvidence: { reads } } : {};

    if (allFailed) {
      const reasons = [...new Set(fileResults.map((r) => r.error).filter((error): error is string => typeof error === 'string'))];
      return { success: false, output: JSON.stringify(output), ...hostEvidence,
        error: `All ${fileResults.length} requested file read${fileResults.length === 1 ? '' : 's'} failed: ${reasons.slice(0, 3).join('; ')}${reasons.length > 3 ? '; …' : ''}` };
    }
    return { success: true, output: JSON.stringify(output), ...hostEvidence };
  }
}
