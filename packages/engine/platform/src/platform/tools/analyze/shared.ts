import { assertCapturedToolReadAccess, assertCapturedToolAccessCurrent, assertCapturedToolInvocationCurrent } from '../shared/captured-input-tools.js';
import { existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { walkDir, type WalkDirOptions } from '../../utils/walk-dir.js';
import type { AnalyzeInput, JsonObject, DiffStatFile } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import { DEFAULT_CEILING_TOKENS, capToolText } from '../../runtime/tools/output-policy.js';

export const BINARY_CHECK_BYTES = 8192;
/** Default discovery covers the requested scope; callers may supply a finite page budget. */
export const MAX_SCAN_FILES = Number.POSITIVE_INFINITY;
/** A project scan stops by itself after this long and says it did, instead of holding the turn on a very large tree. */
export const MAX_SCAN_MS = 60_000;
export const ANALYZE_SUMMARY_SAMPLE_LIMIT = 5;

/** What the start of a file says about it: text, binary content, or a file that could not be read at all. */
async function probeFile(filePath: string): Promise<'text' | 'binary' | 'unreadable'> {
  try {
    await assertCapturedToolReadAccess(filePath);
    const file = Bun.file(filePath);
    if (file.size === 0) return 'text';
    const chunk = await file.slice(0, BINARY_CHECK_BYTES).arrayBuffer();
    const bytes = new Uint8Array(chunk);
    for (const byte of bytes) {
      if (byte === 0) return 'binary';
    }
    return 'text';
  } catch {
    return 'unreadable';
  }
}

export async function isBinary(filePath: string): Promise<boolean> {
  return (await probeFile(filePath)) !== 'text';
}

/**
 * The text files under a directory. A file that cannot be read is not text and not binary: when
 * `unreadable` is given its path is added there, so the caller can say it was not scanned.
 */
export async function collectTextFiles(dirPath: string, limit = MAX_SCAN_FILES, deadline?: number, walkOptions: WalkDirOptions = {}, unreadable?: string[]): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath, {
    ...walkOptions, beforeAttempt: () => {
      assertCapturedToolInvocationCurrent();
      walkOptions.beforeAttempt?.();
    }, beforeAsyncAttempt: async () => {
      await assertCapturedToolAccessCurrent();
      await walkOptions.beforeAsyncAttempt?.();
    },
    shouldContinue: () => walkOptions.shouldContinue?.() !== false && files.length < limit && (deadline === undefined || Date.now() <= deadline),
    site: 'tools.analyze.skip-directory',
  })) {
    if (files.length >= limit) break;
    if (deadline && Date.now() > deadline) break;
    const probe = await probeFile(filePath);
    await assertCapturedToolAccessCurrent();
    walkOptions.signal?.throwIfAborted();
    walkOptions.beforeAttempt?.();
    if (deadline !== undefined && Date.now() > deadline) break;
    if (probe === 'text') files.push(filePath);
    else if (probe === 'unreadable') unreadable?.push(filePath);
  }
  return files;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validatePath(inputPath: string, root: string): string | { error: string } {
  try {
    const resolved = resolve(root, inputPath);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || rel.includes('/..')) {
      return { error: `Path '${inputPath}' is outside the project root` };
    }
    return resolved;
  } catch (err) {
    return { error: summarizeError(err) };
  }
}

/**
 * A model-supplied path resolved against the root. It must stay inside the
 * root, lexically and through links, the same rule the edit tool applies;
 * otherwise this throws and nothing is read.
 */
export function resolveInsideRoot(inputPath: string, root: string): string {
  resolveAndValidatePath(inputPath, root);
  return resolve(root, inputPath);
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    await assertCapturedToolReadAccess(filePath);
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

export async function collectInputFiles(
  inputFiles: string[] | undefined,
  projectRoot: string,
  options: {
    expandDirectories?: boolean | undefined;
    limit?: number | undefined;
    deadline?: number | undefined;
    walkOptions?: WalkDirOptions | undefined;
  } = {},
): Promise<string[]> {
  const expandDirectories = options.expandDirectories ?? false;
  const limit = options.limit ?? MAX_SCAN_FILES;
  const deadline = options.deadline;

  if (!inputFiles || inputFiles.length === 0) {
    return collectTextFiles(projectRoot, limit, deadline, options.walkOptions);
  }

  const files: string[] = [];
  for (const inputFile of inputFiles) {
    if (files.length >= limit) break;
    if (deadline && Date.now() > deadline) break;

    const resolved = resolveInsideRoot(inputFile, projectRoot);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      continue; // Missing or unreadable path.
    }
    if (info.isDirectory()) {
      if (expandDirectories) {
        const remaining = limit - files.length;
        const collected = await collectTextFiles(resolved, remaining, deadline, options.walkOptions);
        files.push(...collected);
      }
      continue;
    }
    files.push(resolved);
  }

  return files;
}

export function sampleArray<T>(value: unknown, limit = ANALYZE_SUMMARY_SAMPLE_LIMIT): T[] {
  return Array.isArray(value) ? (value as T[]).slice(0, limit) : [];
}

export function summarizeAnalyzeResult(
  mode: AnalyzeInput['mode'],
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.provenance === 'classic' && result.assessment === 'unavailable') return {
    mode, provenance: 'classic', assessment: 'unavailable', reason: result.reason, message: result.message,
  };
  const summary = summarizeAnalyzeDetails(mode, result);
  if (result.provenance === 'classic') {
    summary.provenance = 'classic';
    if (result.assessment !== undefined) summary.assessment = result.assessment;
    if (result.message !== undefined) summary.message = result.message;
    if (mode === 'security') summary.secret_assessment = (result.secrets as Record<string, unknown> | undefined)?.assessment ?? null;
  }
  return summary;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function summarizeAnalyzeDetails(mode: AnalyzeInput['mode'], result: Record<string, unknown>): Record<string, unknown> {
  switch (mode) {
    case 'dependencies': {
      const summary: Record<string, unknown> = { mode };
      if (isRecord(result.graph)) summary.fileCount = Object.keys(result.graph).length;
      if (Array.isArray(result.cycles)) {
        summary.has_cycles = result.has_cycles ?? result.cycles.length > 0;
        summary.cycleCount = result.cycles.length;
        summary.cycles = sampleArray<string[]>(result.cycles);
      }
      if (Array.isArray(result.packages)) {
        summary.packageCount = result.packages.length;
        summary.packages = sampleArray<string>(result.packages);
      }
      return summary;
    }
    case 'dead_code':
      return {
        mode,
        total_exports: result.total_exports ?? 0,
        dead_export_count: Array.isArray(result.dead_exports) ? result.dead_exports.length : 0,
        dead_exports: sampleArray<Record<string, unknown>>(result.dead_exports).map((entry) => ({
          name: entry.name ?? null,
          file: entry.file ?? null,
        })),
        ...(result.unverified_count !== undefined ? { unverified_count: result.unverified_count } : {}),
      };
    case 'security': {
      const secrets = (result.secrets as Record<string, unknown> | undefined) ?? {};
      const env = (result.env as Record<string, unknown> | undefined) ?? {};
      const permissions = (result.permissions as Record<string, unknown> | undefined) ?? {};
      return {
        mode,
        secretFindingCount: Array.isArray(secrets.findings) ? secrets.findings.length : 0,
        envFileCount: Array.isArray(env.files_found) ? env.files_found.length : 0,
        permissionFindingCount: Array.isArray(permissions.findings) ? permissions.findings.length : 0,
        topSecretFindings: sampleArray<Record<string, unknown>>(secrets.findings).map((finding) => ({
          file: finding.file ?? null,
          line: finding.line ?? null,
          reading: finding.reading ?? null,
        })),
      };
    }
    case 'surface':
      return {
        mode,
        fileCount: Array.isArray(result.surface) ? result.surface.length : 0,
        total_exports: result.total_exports ?? 0,
        surface: sampleArray<Record<string, unknown>>(result.surface).map((entry) => ({
          file: entry.file ?? null,
          exportCount: Array.isArray(entry.exports) ? entry.exports.length : 0,
          exports: sampleArray<Record<string, unknown>>(entry.exports).map((exp) => exp.name ?? null),
        })),
      };
    case 'impact':
      return {
        mode,
        exported_count: Array.isArray(result.exported_names) ? result.exported_names.length : 0,
        exported_names: sampleArray<string>(result.exported_names),
        total_affected: result.total_affected ?? (Array.isArray(result.affected_files) ? result.affected_files.length : 0),
        affected_files: sampleArray<Record<string, unknown>>(result.affected_files).map((entry) => ({
          file: entry.file ?? null,
          referenceCount: Array.isArray(entry.references) ? entry.references.length : 0,
        })),
      };
    case 'diff': {
      const files = Array.isArray(result.files) ? (result.files as Array<Record<string, unknown>>) : [];
      return {
        mode,
        before: result.before ?? null,
        after: result.after ?? null,
        fileCount: files.length,
        insertions: files.reduce((n, f) => n + (typeof f.insertions === 'number' ? f.insertions : 0), 0),
        deletions: files.reduce((n, f) => n + (typeof f.deletions === 'number' ? f.deletions : 0), 0),
        files: sampleArray<Record<string, unknown>>(files).map((f) => ({ file: f.file ?? null, insertions: f.insertions ?? null, deletions: f.deletions ?? null })),
        ...(result.diff_error !== undefined ? { diff_error: result.diff_error } : {}),
      };
    }
    case 'semantic_diff':
      return {
        mode,
        summary: result.summary ?? null,
        risk: result.risk ?? null,
        impact: sampleArray<string>(result.impact),
        changed_files: sampleArray<string>(result.changed_files),
      };
    case 'breaking': {
      // Classic mode returns the raw diff and assesses nothing; it must not read as "no breaking changes".
      if (!Array.isArray(result.breaking_changes)) {
        const files = Array.isArray(result.files) ? (result.files as Array<Record<string, unknown>>) : [];
        return {
          mode,
          before: result.before ?? null,
          after: result.after ?? null,
          fileCount: files.length,
          files: sampleArray<Record<string, unknown>>(files).map((f) => ({ file: f.file ?? null, insertions: f.insertions ?? null, deletions: f.deletions ?? null })),
        };
      }
      return {
        mode,
        before: result.before ?? null,
        after: result.after ?? null,
        total_breaking: result.total_breaking ?? 0,
        total_additions: result.total_additions ?? 0,
        breaking_changes: sampleArray<Record<string, unknown>>(result.breaking_changes).map((change) => ({
          file: change.file ?? null,
          name: change.name ?? null,
          reason: change.reason ?? null,
        })),
      };
    }
    case 'coverage':
      return {
        mode,
        source: result.source ?? null,
        lines: result.lines ?? null,
        statements: result.statements ?? null,
        branches: result.branches ?? null,
        functions: result.functions ?? null,
      };
    case 'bundle': {
      const data = isRecord(result.data) ? result.data : {};
      return {
        mode,
        source: result.source ?? null,
        topLevelKeys: sampleArray<string>(Object.keys(data), 20),
        assetCount: Array.isArray(data.assets) ? data.assets.length : 0,
        chunkCount: Array.isArray(data.chunks) ? data.chunks.length : 0,
        assets: sampleArray<Record<string, unknown>>(data.assets).map((asset) => ({
          name: asset.name ?? null,
          size: asset.size ?? null,
        })),
      };
    }
    case 'upgrade': {
      const outdated = (Array.isArray(result.packages) ? (result.packages as Array<Record<string, unknown>>) : [])
        .filter((pkg) => isOutdated(String(pkg.current ?? ''), String(pkg.latest ?? '')));
      return {
        mode,
        packageCount: Array.isArray(result.packages) ? result.packages.length : 0,
        outdatedCount: outdated.length,
        outdated: sampleArray<Record<string, unknown>>(outdated).map((pkg) => ({
          name: pkg.name ?? null,
          current: pkg.current ?? null,
          latest: pkg.latest ?? null,
        })),
      };
    }
    case 'permissions':
      return {
        mode,
        total: result.total ?? 0,
        dismissed: result.dismissed ?? 0,
        files_scanned: result.files_scanned ?? 0,
        files_affected: result.files_affected ?? 0,
        by_severity: result.by_severity ?? null,
        findings: sampleArray<Record<string, unknown>>(result.findings).map((finding) => ({
          file: finding.file ?? null,
          line: finding.line ?? null,
          severity: finding.severity ?? null,
        })),
      };
    case 'env_audit': {
      const missing = Array.isArray(result.missing) ? result.missing : [];
      const extra = Array.isArray(result.extra) ? result.extra : [];
      return {
        mode,
        files: result.files ?? [],
        reference: result.reference ?? null,
        missingCount: missing.length,
        missing: sampleArray<Record<string, unknown>>(missing),
        extraCount: extra.length,
        extra: sampleArray<Record<string, unknown>>(extra),
        ...(result.uncertain !== undefined ? { uncertain: result.uncertain } : {}),
      };
    }
    case 'test_find':
      return {
        mode,
        total: result.total ?? 0,
        found: result.found ?? 0,
        missing: result.missing ?? 0,
        mappings: sampleArray<Record<string, unknown>>(result.mappings).map((mapping) => ({
          source: mapping.source ?? null,
          test: mapping.test ?? null,
          exists: mapping.exists ?? false,
        })),
      };
    case 'preview':
      return {
        mode,
        file: result.file ?? null,
        changed_lines: result.changed_lines ?? null,
      };
    default:
      return result;
  }
}

/** The call's `max_tokens`, or the shared default ceiling; a cut result says so and how to get less or more. */
export function applyAnalyzeTokenBudget(output: string, maxTokens: number | undefined): string {
  const limit = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : DEFAULT_CEILING_TOKENS.analyze;
  return capToolText(output, limit, "Pass output.format 'summary', narrow the files or mode options, or raise output.max_tokens to see more.");
}

export async function readJsonFile<T extends JsonObject = JsonObject>(filePath: string): Promise<T | null> {
  try {
    await assertCapturedToolReadAccess(filePath);
    return (await Bun.file(filePath).json()) as T;
  } catch {
    return null;
  }
}

export function resolveScanRoot(input: AnalyzeInput, projectRoot: string): string {
  return input.files && input.files.length > 0 ? resolveInsideRoot(input.files[0]!, projectRoot) : projectRoot;
}

export function collectExistingPaths(projectRoot: string, names: string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(projectRoot, name);
    if (existsSync(candidate)) {
      found.push(name);
    }
  }
  return found;
}

export function loadDependencyVersions(pkgJson: JsonObject): Record<string, string> {
  return {
    ...((pkgJson.dependencies as Record<string, string>) ?? {}),
    ...((pkgJson.devDependencies as Record<string, string>) ?? {}),
  };
}

const GIT_SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

/** A path as git prints it: names with non-ASCII bytes or special characters arrive quoted with C escapes. */
export function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const octal = inner.slice(i + 1, i + 4).match(/^[0-7]{3}/);
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const next = inner[i + 1] ?? '';
    const simple = GIT_SIMPLE_ESCAPES[next];
    if (simple !== undefined) { bytes.push(simple); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseDiffStats(statOutput: string): DiffStatFile[] {
  const files: DiffStatFile[] = [];
  for (const line of statOutput.trim().split('\n')) {
    const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+\-]+)?/);
    if (!m) continue;
    const plusMinus = m[3] ?? '';
    files.push({
      file: unquoteGitPath((m[1] ?? '').trim()),
      insertions: (plusMinus.match(/\+/g) ?? []).length,
      deletions: (plusMinus.match(/-/g) ?? []).length,
    });
  }
  return files;
}

export function findEntryPoint(targetDir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const candidate = join(targetDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function validateGitRefs(
  before: string,
  after: string,
): { error: string; before: string; after: string } | null {
  const safeRefPattern = /^[a-zA-Z0-9_.\-~/^@{}:]+$/;
  if (!safeRefPattern.test(before) || !safeRefPattern.test(after)) {
    return { error: 'Invalid git ref format', before, after };
  }
  // A leading dash would be read by git as an option (`--output <path>` writes a file), never as a revision.
  if (before.startsWith('-') || after.startsWith('-')) {
    return { error: "Invalid git ref: a ref must not start with '-'", before, after };
  }
  return null;
}

export function truncateDiffAtBoundary(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  const window = diff.slice(0, maxChars);
  const fileIdx = window.lastIndexOf('\ndiff --git');
  const hunkIdx = window.lastIndexOf('\n@@');
  const cutAt = fileIdx >= 0 ? fileIdx : hunkIdx >= 0 ? hunkIdx : maxChars;
  const omitted = diff.length - cutAt;
  return diff.slice(0, cutAt) + `\n[...truncated, ${omitted} additional bytes omitted]`;
}

export function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^[^0-9]*/, '');
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0]! ?? 0, parts[1]! ?? 0, parts[2]! ?? 0];
}

/** Whether a manifest spec begins with a version number, after range operators. */
export function hasVersion(spec: string): boolean {
  return /^[\^~<>=v\s]*\d/.test(spec);
}

/** Whether the registry's latest is newer than what the manifest range starts at; a range at the latest version is current. */
export function isOutdated(current: string, latest: string): boolean {
  if (!hasVersion(current) || !hasVersion(latest)) return false;
  const [cur, lat] = [parseSemver(current), parseSemver(latest)];
  for (let i = 0; i < 3; i++) {
    if (lat[i]! !== cur[i]!) return lat[i]! > cur[i]!;
  }
  return false;
}

export function isBreakingUpgrade(current: string, latest: string): boolean {
  const [currentMajor] = parseSemver(current);
  const [latestMajor] = parseSemver(latest);
  if (currentMajor === 0 && latestMajor === 0) {
    const [, currentMinor] = parseSemver(current);
    const [, latestMinor] = parseSemver(latest);
    return latestMinor > currentMinor;
  }
  return latestMajor > currentMajor;
}

/** The variables an env file sets, each mapped to whether its value is blank (empty or an empty quoted string). */
export function parseEnvVariables(content: string): Map<string, boolean> {
  const variables = new Map<string, boolean>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const value = trimmed.slice(eqIdx + 1).trim();
      variables.set(trimmed.slice(0, eqIdx).trim(), value === '' || value === '""' || value === "''");
    }
  }
  return variables;
}

/**
 * The module specifiers a JavaScript or TypeScript file imports, with the
 * 1-based line each starts on: `from '...'` of an import or export
 * (single-line or multi-line), a side-effect `import '...'`, a dynamic
 * `import('...')`, and `require('...')`.
 */
export function importSpecifiers(content: string): Array<{ specifier: string; line: number }> {
  const pattern =
    /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  const found: Array<{ specifier: string; line: number }> = [];
  for (const match of content.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push({ specifier, line: content.slice(0, match.index).split('\n').length });
  }
  return found;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** TypeScript sources a compiled-extension specifier names (`./a.js` is written for `./a.ts`). */
const TS_SOURCE_FOR: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The file a relative specifier imported from `fromFile` names, by Node and
 * TypeScript resolution: the path itself, the path with a source extension,
 * the TypeScript source of a compiled-extension path, or the directory's
 * index file. Null for a package specifier or a path that names no file.
 */
export function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const compiled = extname(base);
  const tsSources = (TS_SOURCE_FOR[compiled] ?? []).map((ext) => base.slice(0, -compiled.length) + ext);
  const tried = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...tsSources,
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  return tried.find(isFile) ?? null;
}
