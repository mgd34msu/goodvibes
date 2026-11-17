import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { capturedAnalyzeSignal, createAnalyzeGitReader, type AnalyzeGitReader } from './captured-git.js';
import { assertCapturedToolAccessCurrent, assertCapturedToolReadAccess } from '../shared/captured-input-tools.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import type { AnalyzeInput, JsonObject, SemanticDiffSummary } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  isBreakingUpgrade,
  loadDependencyVersions,
  parseDiffStats,
  unquoteGitPath,
  parseSemver,
  hasVersion,
  isOutdated,
  readJsonFile,
  truncateDiffAtBoundary,
  validateGitRefs,
  analyzeRefusal,
  type AnalyzeRefusal,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { semanticDiff, semanticDiffView } from '../batteries/semantic-diff.js';
import { exportBreak, exportBreakView } from '../batteries/export-break.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { decisionOrClassic } from '../../runtime/decision-policy.js';

const SEMANTIC_DIFF_SITE = 'tools.analyze.semantic-diff';
const EXPORT_BREAK_SITE = 'tools.analyze.export-break';
/** Changed exports read at once during a breaking-change check. */
const EXPORT_READ_CONCURRENCY = 8;

/** How long the semantic-diff summary waits for the helper model; a slower reply is abandoned and the summary is built from the readings. */
export const SEMANTIC_DIFF_LLM_TIMEOUT_MS = 30_000;
/** Most characters of a diff the diff mode returns. */
const DIFF_OUTPUT_CHARS = 10_000;
/** Registry lookups in flight at once during an upgrade survey. */
const UPGRADE_FETCH_CONCURRENCY = 8;

type SemanticDiffRisk = SemanticDiffSummary['risk'];

/**
 * The risk tier, composed from the two facts Jev read about the diff
 * (tools/batteries/semantic-diff.ts): breaking a caller is high, changing
 * what existing code does is medium, neither is low. A fact the reading is
 * not confident is absent (including a tentative no) counts toward the higher tier,
 * so doubt shows as risk rather than hiding it.
 */
export function semanticDiffRisk(readings: {
  readonly breaks_callers: YesNoReading;
  readonly changes_behavior: YesNoReading;
}): SemanticDiffRisk {
  const present = (reading: YesNoReading): boolean => reading.outcome !== 'act' || reading.verdict !== 'no';
  if (present(readings.breaks_callers)) return 'high';
  if (present(readings.changes_behavior)) return 'medium';
  return 'low';
}

/**
 * Whether a changed export breaks its callers, composed from the two facts
 * Jev read about it (tools/batteries/export-break.ts): either yes is
 * breaking, both no is safe, anything else is uncertain.
 */
export function exportBreakVerdict(readings: {
  readonly inputs_break: YesNoReading;
  readonly output_breaks: YesNoReading;
}): 'breaking' | 'safe' | 'uncertain' {
  const facts = [readings.inputs_break, readings.output_breaks];
  if (facts.some(reading => reading.outcome === 'act' && reading.verdict === 'yes')) return 'breaking';
  return facts.every(reading => reading.outcome === 'act' && reading.verdict === 'no') ? 'safe' : 'uncertain';
}

/** Summary prose built from the readings when the helper model wrote none. */
function summaryFromReadings(changedFiles: readonly string[], risk: SemanticDiffRisk): string {
  const files = changedFiles.length === 0
    ? 'No changed files were detected in the requested diff.'
    : changedFiles.length === 1 ? `Changed ${changedFiles[0]}.` : `Changed ${changedFiles.length} files.`;
  const effect = risk === 'high'
    ? 'Callers of the changed code may have to change too.'
    : risk === 'medium'
      ? 'The change may alter existing behavior.'
      : 'The change neither breaks callers nor changes existing behavior.';
  return `${files} ${effect}`;
}

/**
 * The helper model's summary and impact list. Only the prose is taken from
 * its reply; the risk tier is never parsed from it.
 */
function parseSemanticDiffProse(reply: string): { summary?: string; impact?: string[] } {
  try {
    const cleaned = reply.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { summary?: unknown; impact?: unknown };
    return {
      ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
      ...(Array.isArray(parsed.impact) ? { impact: parsed.impact.map((item) => String(item)) } : {}),
    };
  } catch {
    return { summary: reply.slice(0, 500) };
  }
}

export async function trySemanticDiffLlm(
  toolLLM: Pick<ToolLLM, 'chat'>,
  prompt: string,
  timeoutMs = SEMANTIC_DIFF_LLM_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  // The request is aborted at the deadline or when the call is cancelled, so an abandoned call stops spending tokens.
  const abort = new AbortController();
  const chatSignal = signal === undefined ? abort.signal : AbortSignal.any([abort.signal, signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      toolLLM.chat(prompt, { signal: chatSignal }),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => { abort.abort(); resolve(''); }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // A cancelled call stops here; any other failure leaves the summary to the readings.
    signal?.throwIfAborted();
    return '';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const GIT_FAILURE_HINT = 'Check that both refs exist in this repository (git log --oneline shows them) and that the project root is inside a git work tree.';

function gitFailure(err: unknown, before: string, after: string): AnalyzeRefusal {
  return analyzeRefusal(`git diff failed: ${summarizeError(err)}`, GIT_FAILURE_HINT, { before, after });
}

/** The stat and the patch of a range: in one pass when the reader can, otherwise one call each. */
async function statAndPatch(git: AnalyzeGitReader, before: string, after: string, files: string[] | undefined): Promise<{ stat: string; patch: string; patchError?: unknown }> {
  if (git.diffWithStat) return git.diffWithStat(before, after, files);
  const stat = await git.diffStat(before, after, files);
  try { return { stat, patch: await git.diffBetween(before, after, files) }; }
  catch (patchError) {
    if (git.comparisonInputs) throw patchError;
    return { stat, patch: '', patchError };
  }
}

/** The old and new path of a `diff --git` header line, or undefined for any other line. */
function diffHeaderPaths(line: string): { oldPath: string; newPath: string } | undefined {
  if (!line.startsWith('diff --git ')) return undefined;
  if (!line.includes('"')) {
    const plain = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    return plain ? { oldPath: plain[1]!, newPath: plain[2]! } : undefined;
  }
  // Git quotes a name with non-ASCII or special characters in the header.
  const quoted = line.match(/^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/\S*) ("b\/(?:[^"\\]|\\.)*"|b\/.*)$/);
  return quoted
    ? { oldPath: unquoteGitPath(quoted[1]!).replace(/^a\//, ''), newPath: unquoteGitPath(quoted[2]!).replace(/^b\//, '') }
    : undefined;
}

/** The files a diff text touches, from its `diff --git` headers (both sides, so a rename counts under either name). */
function diffPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    const header = diffHeaderPaths(line);
    if (header) { paths.add(header.oldPath); paths.add(header.newPath); }
  }
  return paths;
}

/**
 * Narrow a `--stat` to the files of an already narrowed diff. Git's stat takes no path list in
 * every reader, so a request for specific files would otherwise list the whole range beside a
 * diff of only those files. Without `files` the stat is returned as is.
 */
export function narrowStatToDiff(statOutput: string, diff: string, files: readonly string[] | undefined): string {
  if (!files || files.length === 0) return statOutput;
  const paths = diffPaths(diff);
  const kept = statOutput.split('\n').filter((line) => {
    const row = parseDiffStats(line)[0];
    if (!row) return false;
    // Git shortens a long name to `.../tail` in a stat row.
    const name = row.file.replace(/^\.\.\./, '');
    return [...paths].some((path) => path === name || path.endsWith(name));
  });
  if (kept.length === 0) return '';
  return `${kept.join('\n')}\n ${kept.length} file${kept.length === 1 ? '' : 's'} changed\n`;
}

export async function runDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = await createAnalyzeGitReader(projectRoot, before, after);

  let statOutput: string;
  let fullDiff: string;
  let diffError: string | undefined;
  try {
    const read = await statAndPatch(git, before, after, input.files);
    statOutput = read.stat;
    fullDiff = read.patch;
    if (read.patchError !== undefined) diffError = `git diff failed after the stat succeeded: ${summarizeError(read.patchError)}`;
  } catch (err) {
    if (git.comparisonInputs) throw err;
    return gitFailure(err, before, after);
  }
  if (diffError === undefined) statOutput = narrowStatToDiff(statOutput, fullDiff, input.files);

  const truncated = fullDiff.length > DIFF_OUTPUT_CHARS;
  return {
    before,
    after,
    ...(git.comparisonInputs ? { comparison_inputs: git.comparisonInputs } : {}),
    stat: statOutput.trim(),
    files: parseDiffStats(statOutput),
    diff: truncated ? truncateDiffAtBoundary(fullDiff, DIFF_OUTPUT_CHARS) : fullDiff,
    ...(truncated ? { diff_truncated: true } : {}),
    ...(diffError !== undefined ? { diff_error: diffError } : {}),
  };
}

/** One exported declaration seen on a side of the diff. */
export interface DiffSignature {
  readonly file: string;
  readonly name: string;
  readonly sig: string;
}

const EXPORT_DECLARATION = /^([+-])\s*export\s+(?:(?:async|default|declare)\s+)*(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)(.*)/;
const EXPORT_LIST = /^([+-])\s*export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*(['"][^'"]+['"]))?/;
const EXPORT_LIST_OPEN = /^[+-]\s*export\s+(?:type\s+)?\{[^}]*$/;
const EXPORT_DEFAULT_ANONYMOUS = /^([+-])\s*export\s+default\s+(?:async\s+)?(?:function\*?\s*\(|class\s*(?:\{|extends\b))/;
const EXPORT_STAR = /^([+-])\s*export\s+\*(?:\s+as\s+(\w+))?\s*from\s*(['"][^'"]+['"])/;
const EXPORT_DEFAULT_EXPR = /^([+-])\s*export\s+default\s+(?!(?:async\s+)?(?:function|class)\b)(.+?);?\s*$/;

/**
 * The exported declarations the diff removes and adds, keyed by file and name: the same name
 * exported from two files is two exports, so removing one while adding the other is a removal.
 */
export function extractSignaturesFromDiff(diff: string): {
  before: Map<string, DiffSignature>;
  after: Map<string, DiffSignature>;
} {
  const before = new Map<string, DiffSignature>();
  const after = new Map<string, DiffSignature>();
  const record = (marker: string, file: string, name: string, sig: string): void => {
    (marker === '-' ? before : after).set(`${file}\0${name}`, { file, name, sig });
  };

  const lines = diff.split('\n');
  let file = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const header = diffHeaderPaths(line);
    if (header) { file = header.newPath; continue; }

    let listText = line;
    if (EXPORT_LIST_OPEN.test(line)) {
      // A multi-line `export {` list: join through the closing brace so its names are seen.
      const marker = line[0]!;
      for (let j = i + 1; j < lines.length; j++) {
        const contLine = lines[j] ?? '';
        if (!contLine.startsWith(marker) && !contLine.startsWith(' ')) break;
        listText += ' ' + contLine.slice(1).trim();
        if (contLine.includes('}')) break;
      }
    }
    const list = listText.match(EXPORT_LIST);
    if (list) {
      const marker = list[1]!;
      for (const specifier of (list[3] ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
        const exported = specifier.split(/\s+as\s+/).pop()!.trim();
        record(marker, file, exported, `${exported} = {${specifier}}${list[4] ? ` from ${list[4]}` : ''}`);
      }
      continue;
    }
    const star = line.match(EXPORT_STAR);
    if (star) {
      const name = star[2] ?? `* from ${star[3]}`;
      record(star[1]!, file, name, `* from ${star[3]}`);
      continue;
    }
    const defaultExpr = line.match(EXPORT_DEFAULT_EXPR);
    if (defaultExpr) {
      record(defaultExpr[1]!, file, 'default', `default ${defaultExpr[2]}`);
      continue;
    }

    const anonymous = line.match(EXPORT_DEFAULT_ANONYMOUS);
    if (anonymous) {
      const head = line.slice(1).trim();
      const brace = head.indexOf('{');
      record(anonymous[1]!, file, 'default', brace >= 0 ? head.slice(0, brace).trimEnd() : head.replace(/;.*$/, '').trimEnd());
      continue;
    }

    const m = line.match(EXPORT_DECLARATION);
    if (!m) continue;

    const marker = (m[1] ?? '+') as '-' | '+'; // regex group 1 is always present when m matches
    const name = m[2] ?? '';
    let rest = m[3];

    if (!rest?.includes('{') && !rest?.includes(';')) {
      for (let j = i + 1; j < lines.length; j++) {
        const contLine = lines[j] ?? '';
        if (!contLine.startsWith(marker) && !contLine.startsWith(' ')) break;
        const stripped = contLine.slice(1);
        rest += ' ' + stripped.trim();
        if (stripped.includes('{') || stripped.includes(';')) break;
      }
    }

    const braceIdx = rest?.indexOf('{') ?? -1;
    const sig = `${name}${braceIdx >= 0 ? (rest ?? '').slice(0, braceIdx).trimEnd() : (rest ?? '').replace(/;.*$/, '').trimEnd()}`;
    record(marker, file, name, sig);
  }

  return { before, after };
}

export async function runBreaking(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  return decisionOrClassic(() => runDecisionBreaking(input, projectRoot), async () => ({
    ...await runDiff(input, projectRoot), provenance: 'classic', assessment: 'unassessed',
    message: 'Classic exposes the actual diff. Semantic compatibility assessment requires a decision model.',
  }));
}
async function runDecisionBreaking(input: AnalyzeInput, projectRoot: string): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = await createAnalyzeGitReader(projectRoot, before, after);

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch (err) {
    if (git.comparisonInputs) throw err;
    return gitFailure(err, before, after);
  }

  const { before: beforeSigs, after: afterSigs } = extractSignaturesFromDiff(fullDiff);
  const breaking_changes: Array<{ file: string; name: string; before: string; after: string; reason: string; reading?: 'uncertain' }> = [];
  const additions: Array<{ file: string; name: string; signature: string }> = [];
  const safe_modifications: Array<{ file: string; name: string; before: string; after: string }> = [];
  const changed: Array<{ file: string; name: string; before: string; after: string }> = [];

  for (const [key, { file, name, sig }] of beforeSigs) {
    const newSig = afterSigs.get(key)?.sig;
    if (newSig === undefined) {
      // The name is gone from this file, so every caller that imports it from here must change.
      breaking_changes.push({ file, name, before: sig, after: '(removed)', reason: 'export removed' });
    } else if (sig === newSig) {
      safe_modifications.push({ file, name, before: sig, after: newSig });
    } else {
      changed.push({ file, name, before: sig, after: newSig });
    }
  }

  // Whether a changed declaration breaks its callers is read per export; safe is listed as safe, anything else as breaking.
  const verdicts = await mapWithConcurrency(changed, EXPORT_READ_CONCURRENCY, async (change) => {
    await assertCapturedToolAccessCurrent();
    const run = await exportBreak.run(judgmentPort(EXPORT_BREAK_SITE), exportBreakView(change.name, change.before, change.after), { site: EXPORT_BREAK_SITE });
    const verdict = exportBreakVerdict(run.readings);
    run.recordAction(`listed as ${verdict}`);
    return verdict;
  });
  changed.forEach((change, index) => {
    const verdict = verdicts[index]!;
    if (verdict === 'safe') safe_modifications.push(change);
    else if (verdict === 'breaking') breaking_changes.push({ ...change, reason: 'callers must change' });
    else breaking_changes.push({ ...change, reason: 'callers may have to change', reading: 'uncertain' });
  });

  for (const [key, { file, name, sig }] of afterSigs) {
    if (!beforeSigs.has(key)) {
      additions.push({ file, name, signature: sig });
    }
  }

  return {
    before,
    after,
    ...(git.comparisonInputs ? { comparison_inputs: git.comparisonInputs } : {}),
    breaking_changes,
    additions,
    safe_modifications,
    total_breaking: breaking_changes.length,
    total_additions: additions.length,
  };
}

export async function runSemanticDiff(
  input: AnalyzeInput,
  projectRoot: string,
  toolLLM: Pick<ToolLLM, 'chat'>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return decisionOrClassic(() => runDecisionSemanticDiff(input, projectRoot, toolLLM, signal), async () => ({
    ...await runDiff(input, projectRoot), provenance: 'classic', risk: 'unassessed', summary_source: 'classic',
    message: 'Classic exposes the actual diff. Semantic behavior and risk assessment require a decision model.',
  }));
}
async function runDecisionSemanticDiff(input: AnalyzeInput, projectRoot: string, toolLLM: Pick<ToolLLM, 'chat'>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = await createAnalyzeGitReader(projectRoot, before, after);

  let fullDiff: string;
  let statOutput: string;
  try {
    const read = await statAndPatch(git, before, after, input.files);
    if (read.patchError !== undefined) throw read.patchError;
    fullDiff = read.patch;
    statOutput = narrowStatToDiff(read.stat, fullDiff, input.files);
  } catch (err) {
    if (git.comparisonInputs) throw err;
    return gitFailure(err, before, after);
  }

  const changedFiles = parseDiffStats(statOutput).map((file) => file.file);
  const range = `${before}..${after}`;

  await assertCapturedToolAccessCurrent();
  const run = await semanticDiff.run(
    judgmentPort(SEMANTIC_DIFF_SITE),
    semanticDiffView(range, changedFiles, fullDiff),
    { site: SEMANTIC_DIFF_SITE },
  );
  const risk = semanticDiffRisk(run.readings);
  run.recordAction(`reported risk ${risk}`);

  const prompt =
    `You are a code reviewer. Analyze the following git diff and provide:
1. A concise summary of what changed and why (2-4 sentences)
2. Impact analysis: list the downstream functions/modules/callers that may be affected

Respond in JSON with fields: summary (string), impact (array of strings)

Diff (${range}):
${truncateDiffAtBoundary(fullDiff, 6000)}`;

  await assertCapturedToolAccessCurrent();
  const reply = await trySemanticDiffLlm(toolLLM, prompt, SEMANTIC_DIFF_LLM_TIMEOUT_MS, signal);
  const prose = reply ? parseSemanticDiffProse(reply) : {};

  return {
    before,
    after,
    ...(git.comparisonInputs ? { comparison_inputs: git.comparisonInputs } : {}),
    summary: prose.summary ?? summaryFromReadings(changedFiles, risk),
    impact: prose.impact ?? changedFiles.map((file) => `Changed file: ${file}`),
    risk,
    risk_readings: {
      breaks_callers: run.readings.breaks_callers.verdict,
      changes_behavior: run.readings.changes_behavior.verdict,
    },
    summary_source: prose.summary !== undefined ? 'llm' : 'readings',
    changed_files: changedFiles,
  };
}

export async function runUpgrade(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  let packageNames: string[];
  const pkgPath = join(projectRoot, 'package.json');
  // Authorize the captured package, even when explicit package names skip dependency discovery.
  await assertCapturedToolReadAccess(pkgPath);
  const explicit = input.packages && input.packages.length > 0 ? input.packages : null;

  // package.json is read once: it names the dependencies and their current versions.
  let currentVersions: Record<string, string> = {};
  let projectScope: string | null = null;
  if (existsSync(pkgPath)) {
    const pkgJson = await readJsonFile(pkgPath);
    if (pkgJson !== null) {
      currentVersions = loadDependencyVersions(pkgJson);
      projectScope = ownScope(pkgJson);
    } else if (!explicit) {
      return analyzeRefusal('Failed to parse package.json', 'Fix the JSON in package.json, or pass packages with the package names to check.');
    }
  } else if (!explicit) {
    return analyzeRefusal('No package.json found and no packages specified', 'Pass packages with the package names to check, or point projectRoot at a directory holding package.json.', { projectRoot });
  }

  if (explicit) {
    packageNames = explicit;
  } else {
    packageNames = Object.keys(currentVersions);
    if (packageNames.length === 0) {
      return { packages: [], total: 0, outdated: 0, breaking: 0 };
    }
  }

  type UpgradeRow = { name: string; current: string; latest: string; breaking: boolean };
  const invocationSignal = capturedAnalyzeSignal();
  // Every package is checked, a few at a time. A spec the registry does not own (a workspace
  // link, a git URL, an alias) and a package of the project's own scope are never sent to the
  // public registry: the lookup would disclose the name and could answer with an unrelated package.
  const results: UpgradeRow[] = await mapWithConcurrency(packageNames, UPGRADE_FETCH_CONCURRENCY, async (name): Promise<UpgradeRow> => {
    const current = currentVersions[name] ?? 'unknown';
    await assertCapturedToolAccessCurrent();
    if (!isRegistrySpec(current) || (projectScope !== null && name.startsWith(`${projectScope}/`))) {
      return { name, current, latest: NOT_FROM_REGISTRY, breaking: false };
    }
    try {
      const res = await instrumentedFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
        signal: invocationSignal ? AbortSignal.any([invocationSignal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { name, current, latest: LOOKUP_UNKNOWN, breaking: false };
      const data = await res.json() as { version?: string };
      const latest = data.version ?? LOOKUP_UNKNOWN;
      const breaking = hasVersion(current) && latest !== LOOKUP_UNKNOWN ? isBreakingUpgrade(current, latest) : false;
      return { name, current, latest, breaking };
    } catch {
      return { name, current, latest: LOOKUP_FAILED, breaking: false };
    }
  });

  results.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const notFromRegistry = results.filter((r) => r.latest === NOT_FROM_REGISTRY).length;
  // A lookup that failed is not "up to date": it is counted apart, and the survey says it is incomplete.
  const lookedUp = results.length - notFromRegistry;
  const lookupFailed = results.filter((r) => r.latest === LOOKUP_UNKNOWN || r.latest === LOOKUP_FAILED).length;
  if (lookedUp > 0 && lookupFailed === lookedUp) {
    return analyzeRefusal(`No registry lookup succeeded (${lookupFailed} failed)`, 'Check the network connection to registry.npmjs.org and run upgrade again.', { packages: results });
  }
  return {
    packages: results,
    total: results.length,
    outdated: results.filter((r) => isOutdated(r.current, r.latest)).length,
    breaking: results.filter((r) => r.breaking).length,
    ...(lookupFailed > 0 ? {
      lookup_failed: lookupFailed,
      message: `${lookupFailed} registry lookups failed, so this survey is incomplete: those packages may be outdated. Run upgrade again when the registry answers.`,
    } : {}),
    ...(notFromRegistry > 0 ? { not_from_registry: notFromRegistry, note: `${notFromRegistry} dependencies were not looked up: workspace, git, file, alias and own-scope specs are not registry versions.` } : {}),
  };
}

const NOT_FROM_REGISTRY = 'not_from_registry';
/** The registry answered without a version (a non-2xx status or no `version`). */
const LOOKUP_UNKNOWN = 'unknown';
/** The registry could not be reached. */
const LOOKUP_FAILED = 'fetch_failed';

/** A spec the public registry can answer for: a semver range or a dist-tag, not a link, URL, alias or workspace form. */
function isRegistrySpec(spec: string): boolean {
  if (spec === 'unknown') return true;
  return !/^(?:workspace|catalog|file|link|portal|patch|npm|git|git\+\w+|github|gitlab|bitbucket|https?):/.test(spec) && !spec.includes('/');
}

/** The scope (`@scope`) of the project's own package name, if it has one. */
function ownScope(pkg: JsonObject): string | null {
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  return name.startsWith('@') && name.includes('/') ? name.slice(0, name.indexOf('/')) : null;
}
