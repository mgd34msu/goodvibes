import type { WalkDirOptions } from '../../utils/walk-dir.js';
import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
/**
 * The analyze modes whose findings are read by Jev: `security` (secrets,
 * env files, world-writable files) and `permissions` (dangerous calls).
 *
 * Code chooses the candidate lines: for secrets the local credential
 * detectors (issuer formats and credential-shaped values, utils/redaction.ts)
 * and assignments to a secret-named field; for permissions a table of risky
 * call shapes. Only candidates are read, each once, with the few lines around
 * it (`engine.tools.secret-finding`, `engine.tools.dangerous-call`), so the
 * requests follow the number of candidates, never the size of the files. A
 * scan stops reading files and starting readings at MAX_SCAN_MS, makes at
 * most MAX_SCAN_READINGS requests, and says what it covered; a candidate left
 * unread, or read while decision models are off or unreachable, is listed as
 * `unassessed`, never dropped. The env-file list and the world-writable mode
 * bit are facts about the file system, reported as they are.
 */
import { readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { YesNoReading } from '@goodvibes/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { MAX_JUDGED_SCAN_LINE_CHARS, scanCandidateView, secretFinding } from '../batteries/secret-finding.js';
import { dangerousCall, type DangerSeverity } from '../batteries/dangerous-call.js';
import { assertJudgmentInput, judgmentInputRefusal, JudgmentInputError } from '../../gate/judgment-input.js';
import type { AnalyzeInput } from './types.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { judge } from '../../runtime/judge.js';
import { containsIssuerCredential, findCredentialCandidates, firstIssuerCredentialIndex, redactIssuerCredentials } from '../../utils/redaction.js';
import { MAX_SCAN_MS, collectExistingPaths, collectScanFiles, readTextFile } from './shared.js';

const SECRET_SITE = 'tools.analyze.secret-finding';
const DANGER_SITE = 'tools.analyze.dangerous-call';
/** Candidates read at once during a scan. */
const SCAN_READ_CONCURRENCY = 8;
/** Most decision-model requests one scan makes; candidates past it are listed unassessed. */
export const MAX_SCAN_READINGS = 200;

/**
 * How a reported finding stands: a yes (`real`), a reading that is neither
 * yes nor no (`uncertain`), a line code knows holds credential material
 * (`local-pattern`), or a candidate no reading assessed (`unassessed`).
 */
type FindingReading = 'real' | 'uncertain' | 'local-pattern' | 'unassessed';
type SecretRead = FindingReading | 'dismissed';

/** Acting yes/no readings settle a finding; other evidence remains visible as uncertain. */
function findingReading(reading: YesNoReading): Exclude<FindingReading, 'local-pattern' | 'unassessed'> | 'dismissed' {
  if (reading.outcome !== 'act') return 'uncertain';
  if (reading.verdict === 'yes') return 'real';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

interface ScanCandidate {
  readonly file: string;
  readonly lines: readonly string[];
  readonly index: number;
  /** Where on the line the candidate was found: a long line is carried to the reading around it. */
  readonly focus: number;
}

interface ScannedFile {
  readonly file: string;
  readonly lines: readonly string[];
}

/**
 * A field assigned a literal value: a quoted string of 8 or more characters with no space or
 * brace, or a bare run of 8 or more (`.env`, YAML). A value holding `.`, `(`, `[` or `{` is an
 * expression (`session.id`, `estimateTokens(text)`), not a stored secret.
 */
const LITERAL_ASSIGNMENT = /([A-Za-z_$][\w$-]*)["'`]?\s*(?::=|[:=])\s*(?:(["'`])([^\s"'`{}]{8,})\2|([^\s"'`,;.()[\]{}=<>|&!?+*/\\]{8,})(?=[\s,;]|$))/g;
/** The last word of a field name that makes it a secret's name. */
const SECRET_NAME_WORDS = new Set(['secret', 'secrets', 'token', 'password', 'passwd', 'pwd', 'passphrase', 'credential', 'credentials', 'bearer', 'auth', 'apikey']);
/** Words that make a following `key` a credential (`apiKey`, `PRIVATE_KEY`), not a lookup key. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'client', 'signing', 'encryption', 'master', 'auth', 'license', 'ssh', 'app', 'consumer', 'service', 'account', 'webhook', 'session']);
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Whether a field name names a secret by its last whole word (`apiKey`, `CLIENT_SECRET`,
 * `authToken`, `db-password`), so a name that only contains such a word (keyboard, author,
 * tokenizer, tokenCount, passwordPolicy) is not one.
 */
function namesSecret(name: string): boolean {
  const parts = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '');
  const last = parts[parts.length - 1];
  if (last === undefined) return false;
  if (SECRET_NAME_WORDS.has(last)) return true;
  return last === 'key' && parts.length > 1 && KEY_QUALIFIERS.has(parts[parts.length - 2]!);
}

/**
 * Where the first secret-named field assigned a literal starts (`apiKey = "…"`, `password: '…'`,
 * `SECRET_TOKEN=a1b2…`), or -1. A bare value needs a letter and a digit (`undefined`, `string`
 * are types and keywords).
 */
function secretAssignmentIndex(line: string): number {
  for (const match of line.matchAll(LITERAL_ASSIGNMENT)) {
    const bare = match[4];
    if (bare !== undefined && !(/[A-Za-z]/.test(bare) && /\d/.test(bare))) continue;
    if (namesSecret(match[1] ?? '')) return match.index ?? 0;
  }
  return -1;
}

/** Whether code knows the line holds credential material (an issuer format or a credential-shaped value). */
function holdsLocalCredential(line: string): boolean {
  return containsIssuerCredential(line) || findCredentialCandidates(line).length > 0 || PRIVATE_KEY_BLOCK.test(line);
}

/** The smallest of the offsets that were found (-1 means not found), or -1 when none was. */
function firstFound(...offsets: readonly number[]): number {
  const found = offsets.filter((offset) => offset >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

/** Where on the line a secret candidate is (credential material or a secret-named literal), or -1 when it is none. */
function secretCandidateIndex(line: string): number {
  return firstFound(
    firstIssuerCredentialIndex(line),
    findCredentialCandidates(line)[0]?.start ?? -1,
    line.search(PRIVATE_KEY_BLOCK),
    secretAssignmentIndex(line),
  );
}

/**
 * Call shapes that can run code or commands, open files to everyone, write
 * unescaped HTML or build a pattern from outside input. Names shared with
 * harmless calls (a regex `.exec`, a database `exec`) are kept: the reading
 * dismisses those.
 */
const DANGEROUS_CALL_SHAPES: readonly RegExp[] = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bvm\.(?:runIn\w*Context|compileFunction|Script)\b/,
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/,
  /\bBun\.(?:spawn|spawnSync|\$)\b/,
  /\b(?:os\.system|os\.popen|subprocess\.\w+|Runtime\.getRuntime\(\)\.exec)\s*\(/,
  /\bshell\s*:\s*true\b/,
  /\bchmod(?:Sync)?\s*\(|\bchmod\s+(?:-R\s+)?[0-7]{3,4}\b/,
  /dangerouslySetInnerHTML/,
  /\.(?:innerHTML|outerHTML)\s*\+?=/,
  /\binsertAdjacentHTML\s*\(/,
  /\bdocument\.write(?:ln)?\s*\(/,
  /\bnew\s+RegExp\s*\(\s*[^'"`/\s)]/,
  /\b(?:pickle\.loads|yaml\.load|unserialize)\s*\(/,
];

/** Where on the line the first risky call shape is, or -1 when it has none. */
function dangerousCallIndex(line: string): number {
  return firstFound(...DANGEROUS_CALL_SHAPES.map((shape) => line.search(shape)));
}

/**
 * The matched line as the report shows it. Issuer-format and candidate-shape credentials are
 * masked; with `maskValues` (the secret scan) every quoted string and every value after `=` or
 * `:` is masked too, since the line was flagged for holding a secret.
 */
function matchText(candidate: ScanCandidate, max: number, maskValues = false): string {
  let text = redactIssuerCredentials((candidate.lines[candidate.index] ?? '').trim());
  for (const span of findCredentialCandidates(text).reverse()) text = text.slice(0, span.start) + span.marker + text.slice(span.end);
  if (maskValues) {
    text = text.replace(/(["'`])(?:(?!\1).)*\1/g, '$1[redacted]$1').replace(/([=:]\s*)([^\s"'`;,)\][]{4,})/g, '$1[redacted]');
  }
  return text.slice(0, max);
}

/** The root's env files by the dotenv convention: `.env` and every `.env.<suffix>`. */
export function listProjectEnvFiles(projectRoot: string): string[] {
  try {
    return readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name === '.env' || entry.name.startsWith('.env.')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** What one scan covered: files read of those found, readings made, and whether the limit cut it short. */
interface ScanCoverage {
  readonly scanned: ScannedFile[];
  readonly unreadable: string[];
  readonly filesTotal: number;
  stopped: boolean;
}

/** Reads the scan's files until the deadline; files not reached are counted, not read. */
async function readScanFiles(input: AnalyzeInput, projectRoot: string, deadline: number, walkOptions: WalkDirOptions): Promise<ScanCoverage> {
  const unreadablePaths: string[] = [];
  const files = await collectScanFiles(input, projectRoot, deadline, walkOptions, unreadablePaths);
  const scanned: ScannedFile[] = [];
  let stopped = false;
  for (const file of files) {
    walkOptions.signal?.throwIfAborted();
    if (Date.now() > deadline) { stopped = true; break; }
    const content = await readTextFile(file);
    if (content === null) unreadablePaths.push(file);
    else scanned.push({ file: relative(projectRoot, file), lines: content.split('\n') });
  }
  await assertCapturedToolAccessCurrent();
  return { scanned, unreadable: unreadablePaths.map((file) => relative(projectRoot, file)), filesTotal: files.length, stopped: stopped || Date.now() > deadline };
}

/** The candidate lines, each with where on it `locate` found what made it one (-1: not a candidate). */
function candidatesOf(scanned: readonly ScannedFile[], locate: (line: string) => number): ScanCandidate[] {
  return scanned.flatMap(({ file, lines }) => lines.flatMap((line, index) => {
    if (line.trim() === '') return [];
    const focus = locate(line);
    return focus >= 0 ? [{ file, lines, index, focus }] : [];
  }));
}

/**
 * Reads each candidate once, at most MAX_SCAN_READINGS requests and none started after the
 * deadline; candidates `first` names are read before the rest. A view the input check refuses
 * to send gets `refused`. Only a reading that reached the decision model counts as a request,
 * and with decision models off nothing is read or limited: every candidate is `unassessed`.
 */
async function readCandidates<R>(
  candidates: readonly ScanCandidate[],
  options: {
    readonly deadline: number;
    readonly coverage: ScanCoverage;
    readonly signal: AbortSignal | undefined;
    readonly classic: boolean;
    readonly first?: (candidate: ScanCandidate) => boolean;
  },
  read: (view: ReturnType<typeof scanCandidateView>) => Promise<{ readonly value: R; readonly requested?: boolean }>,
  unassessed: R,
  refused: R,
): Promise<{ readings: R[]; requests: number; unassessedCount: number }> {
  const { deadline, coverage, signal, classic, first } = options;
  if (classic) return { readings: candidates.map(() => unassessed), requests: 0, unassessedCount: 0 };
  let requests = 0;
  // Requests made plus readings in flight, so concurrent readings cannot pass the cap together.
  let reserved = 0;
  let unassessedCount = 0;
  const order = candidates.map((_candidate, index) => index);
  if (first !== undefined) {
    const marked = candidates.map(first);
    order.sort((a, b) => Number(marked[b]) - Number(marked[a]) || a - b);
  }
  const readings = new Array<R>(candidates.length);
  await mapWithConcurrency(order, SCAN_READ_CONCURRENCY, async (index): Promise<void> => {
    const candidate = candidates[index]!;
    const view = scanCandidateView(candidate.file, candidate.lines, candidate.index, undefined, candidate.focus);
    try { assertJudgmentInput(view); }
    catch (error) {
      if (error instanceof JudgmentInputError) { readings[index] = refused; return; }
      throw error;
    }
    if (reserved >= MAX_SCAN_READINGS || Date.now() > deadline) {
      coverage.stopped = true;
      unassessedCount++;
      readings[index] = unassessed;
      return;
    }
    reserved++;
    const outcome = await read(view);
    if (outcome.requested === true) requests++;
    else reserved--;
    readings[index] = outcome.value;
  });
  if (signal?.aborted) signal.throwIfAborted();
  return { readings, requests, unassessedCount };
}

function coverageNote(coverage: ScanCoverage, unassessedCount: number): { scan_note?: string } {
  if (!coverage.stopped) return {};
  return {
    scan_note: `Stopped at the scan limit: covers ${coverage.scanned.length} of ${coverage.filesTotal} files${unassessedCount > 0 ? `, and ${unassessedCount} candidates are listed unassessed` : ''}. Narrow 'files' to see the rest.`,
  };
}

/** One finding of the secret scan. */
export type SecretScanFinding = { file: string; line: number; match: string; reading: FindingReading };

/**
 * What `analyze mode:"security"` returns: the secret scan, the env files and
 * the world-writable files, each present when its scope ran. The short form
 * reads its counts from these fields, so a renamed field fails the type check.
 */
export type SecurityScanResult = {
  provenance?: 'classic';
  secrets?: {
    findings: SecretScanFinding[];
    count: number;
    dismissed: number;
    candidates: number;
    requests_made: number;
    files_scanned: number;
    files_total: number;
    assessment?: 'local-patterns-only';
    semanticVerification?: false;
    unreadable_files?: string[];
    scan_note?: string;
  };
  env?: { files_found: string[] };
  permissions?: { world_writable: string[]; count: number; unreadable_files?: string[] };
  stopped_by_deadline: boolean;
};

export async function runSecurity(input: AnalyzeInput, projectRoot: string, walkOptions: WalkDirOptions = {}): Promise<SecurityScanResult> {
  const scope = input.securityScope ?? 'all';
  const deadline = Date.now() + MAX_SCAN_MS;
  const classic = isClassicOperation();
  const results: Omit<SecurityScanResult, 'stopped_by_deadline'> = classic ? { provenance: 'classic' } : {};
  let stopped = false;

  if (scope === 'secrets' || scope === 'all') {
    const coverage = await readScanFiles(input, projectRoot, deadline, walkOptions);
    const candidates = candidatesOf(coverage.scanned, secretCandidateIndex);
    const { readings, requests, unassessedCount } = await readCandidates(candidates, {
      deadline, coverage, signal: walkOptions.signal, classic,
      // Lines code already knows hold credential material are read before assignments.
      first: (candidate) => holdsLocalCredential(candidate.lines[candidate.index] ?? ''),
    }, (view) => judge<typeof secretFinding.items, SecretRead>({
      site: SECRET_SITE,
      battery: secretFinding,
      state: view,
      settle: ({ real_secret: reading }) => findingReading(reading),
      fallback: () => 'unassessed',
      describe: (reading) => reading === 'dismissed' ? 'dismissed' : `reported as ${reading}`,
      ...(walkOptions.signal === undefined ? {} : { signal: walkOptions.signal }),
    // A view the input check refuses (the line or a neighbour holds credential material) was not read: unassessed.
    }), 'unassessed' as SecretRead, 'unassessed' as SecretRead);
    const findings = candidates.flatMap((candidate, index): SecretScanFinding[] => {
      let reading = readings[index]!;
      const line = candidate.lines[candidate.index] ?? '';
      const localCredential = holdsLocalCredential(line);
      // A dismissal of a line too long to carry whole judged part of it only: a line code
      // knows holds credential material is not dropped on it.
      if (reading === 'dismissed') {
        if (!(localCredential && line.length > MAX_JUDGED_SCAN_LINE_CHARS)) return [];
        reading = 'local-pattern';
      }
      // Code-detected credential material only when the candidate line itself holds it,
      // never because a neighbouring line did.
      if ((reading === 'unassessed' || reading === 'uncertain') && (localCredential || judgmentInputRefusal(line) !== undefined)) reading = 'local-pattern';
      return [{ file: candidate.file, line: candidate.index + 1, match: matchText(candidate, 60, true), reading }];
    });
    stopped ||= coverage.stopped;
    results.secrets = {
      findings, count: findings.length, dismissed: candidates.length - findings.length,
      candidates: candidates.length, requests_made: requests,
      files_scanned: coverage.scanned.length, files_total: coverage.filesTotal,
      ...(classic ? { assessment: 'local-patterns-only' as const, semanticVerification: false as const } : {}),
      ...(coverage.unreadable.length > 0 ? { unreadable_files: coverage.unreadable } : {}),
      ...coverageNote(coverage, unassessedCount),
    };
  }

  if (scope === 'env' || scope === 'all') {
    results.env = {
      files_found: collectExistingPaths(projectRoot, listProjectEnvFiles(projectRoot)),
    };
  }

  if (scope === 'permissions' || scope === 'all') {
    const suspicious: string[] = [];
    const unreadablePaths: string[] = [];
    const files = await collectScanFiles(input, projectRoot, deadline, walkOptions, unreadablePaths);
    for (const file of files) {
      walkOptions.signal?.throwIfAborted();
      try {
        const info = await stat(file);
        if ((info.mode & 0o002) !== 0) suspicious.push(relative(projectRoot, file));
      } catch {
        unreadablePaths.push(file);
      }
    }
    stopped ||= Date.now() > deadline;
    results.permissions = {
      world_writable: suspicious, count: suspicious.length,
      ...(unreadablePaths.length > 0 ? { unreadable_files: unreadablePaths.map((file) => relative(projectRoot, file)) } : {}),
    };
  }

  await assertCapturedToolAccessCurrent();
  // Always stated: the tool-level note follows this flag, not how long the scan took.
  return { ...results, stopped_by_deadline: stopped };
}

export async function runPermissions(input: AnalyzeInput, projectRoot: string, walkOptions: WalkDirOptions = {}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MAX_SCAN_MS;
  const classic = isClassicOperation();
  const coverage = await readScanFiles(input, projectRoot, deadline, walkOptions);
  const candidates = candidatesOf(coverage.scanned, dangerousCallIndex);
  type Read = { reading: FindingReading | 'dismissed'; severity: DangerSeverity | 'unrated' };
  const unassessed: Read = { reading: 'unassessed', severity: 'unrated' };
  const { readings, requests, unassessedCount } = await readCandidates<Read>(candidates, {
    deadline, coverage, signal: walkOptions.signal, classic,
  }, (view) => judge<typeof dangerousCall.items, Read>({
    site: DANGER_SITE,
    battery: dangerousCall,
    state: view,
    settle: ({ risky, severity }) => ({ reading: findingReading(risky), severity: severity.outcome === 'act' ? severity.choice : 'unrated' }),
    fallback: () => unassessed,
    describe: ({ reading, severity }) => reading === 'dismissed' ? 'dismissed' : `reported as ${reading}, ${severity}`,
    ...(walkOptions.signal === undefined ? {} : { signal: walkOptions.signal }),
  }), unassessed, unassessed);
  const findings = candidates.flatMap((candidate, index) => {
    const { reading, severity } = readings[index]!;
    return reading === 'dismissed'
      ? []
      : [{ file: candidate.file, line: candidate.index + 1, severity, reading, match: matchText(candidate, 100) }];
  });

  const byFile: Record<string, number> = {};
  for (const f of findings) {
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  }
  await assertCapturedToolAccessCurrent();

  return {
    ...(classic ? { provenance: 'classic', assessment: 'call-shapes-only', message: 'Decision models are off: every risky call shape is listed unassessed.' } : {}),
    findings,
    total: findings.length,
    dismissed: candidates.length - findings.length,
    candidates: candidates.length,
    requests_made: requests,
    files_scanned: coverage.scanned.length,
    files_total: coverage.filesTotal,
    ...(coverage.unreadable.length > 0 ? { unreadable_files: coverage.unreadable } : {}),
    // Always stated: the tool-level note must follow this flag, not how long the judgments took.
    stopped_by_deadline: coverage.stopped,
    ...coverageNote(coverage, unassessedCount),
    files_affected: Object.keys(byFile).length,
    by_severity: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      unrated: findings.filter((f) => f.severity === 'unrated').length,
    },
  };
}
