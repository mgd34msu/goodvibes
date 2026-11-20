import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { defineFormat } from '../utils/format-codec.js';

/**
 * Structured completion reports, per-archetype output contracts. Agents end
 * their final output with one as a fenced JSON block (the format the agent
 * prompt dictates, read here as a fixed format). The contract runner reads a
 * unit's report to verify its claims (contract/claims.ts) and to take its
 * result (or summary when absent) as the unit's answer (contract/answer.ts).
 */

/** Base fields shared by all completion reports. */
export interface BaseCompletionReport {
  version: 1;
  archetype: string;
  summary: string;
  /** A complete replacement user-facing answer from a deliverable repair. Supporting results do not replace the final answer. */
  finalAnswer?: string;
}

/** Engineer agent completion report. */
export interface EngineerReport extends BaseCompletionReport {
  archetype: 'engineer';
  gatheredContext: string[];
  plannedActions: string[];
  appliedChanges: string[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  decisions: Array<{ what: string; why: string }>;
  issues: string[];
  uncertainties: string[];
}

/** Tester agent completion report. */
export interface TesterReport extends BaseCompletionReport {
  archetype: 'tester';
  testsWritten: string[];
  testsPassed: number;
  testsFailed: number;
  coverage?: { lines: number; branches: number; functions: number };
  failures: Array<{ test: string; error: string }>;
}

/** Generic completion report for other archetypes. */
export interface GenericReport extends BaseCompletionReport {
  /** Archetype name, for every archetype other than engineer and tester. */
  archetype: string;
  result: string;
}

export type CompletionReport = EngineerReport | TesterReport | GenericReport;

/** A fenced ```json block: the opening fence on its own line, the closing fence on its own line. */
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

const STRING_FIELDS = ['summary', 'finalAnswer', 'result'] as const;
const STRING_LIST_FIELDS = ['filesCreated', 'filesModified', 'filesDeleted', 'gatheredContext', 'plannedActions', 'appliedChanges', 'issues', 'uncertainties', 'testsWritten'] as const;

/**
 * The completion report format, read the one way every reader reads it (the
 * contract's answer, its claim check): `version` 1, a string `archetype`, and
 * each known field of the type its readers use (text fields text, path lists
 * lists of text). An object that breaks one is not a report: the output is
 * then read as plain text, so a malformed footer never costs the answer.
 */
export const COMPLETION_REPORT_FORMAT = defineFormat<CompletionReport>({
  name: 'completion report',
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
    const record = raw as Readonly<Record<string, unknown>>;
    if (record.version !== 1) return { ok: false, reason: 'version is not 1' };
    if (typeof record.archetype !== 'string') return { ok: false, reason: 'archetype is not text' };
    for (const field of STRING_FIELDS) {
      if (record[field] !== undefined && typeof record[field] !== 'string') return { ok: false, reason: `${field} is not text` };
    }
    for (const field of STRING_LIST_FIELDS) {
      const value = record[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) return { ok: false, reason: `${field} is not a list of text` };
    }
    return { ok: true, value: raw as CompletionReport };
  },
  render(report) { return report; },
});

/**
 * The report the agent prompt dictates: the LAST fenced ```json block of the
 * output (the report ends the message), whose object has `version` 1 and a
 * string `archetype`. Null when the last block is not such an object, or there
 * is no block. Nothing is read out of prose.
 */
export function parseCompletionReport(rawOutput: string): CompletionReport | null {
  return parseCompletionReportParts(rawOutput)?.report ?? null;
}

/** Keep the answer outside a valid report footer; never discard it in favor of bookkeeping. */
export function parseCompletionReportParts(rawOutput: string): { readonly report: CompletionReport; readonly body: string } | null {
  let last: RegExpExecArray | undefined;
  for (const match of rawOutput.matchAll(JSON_FENCE)) last = match;
  if (last === undefined) return null;
  try {
    const parsed = COMPLETION_REPORT_FORMAT.parse(JSON.parse(last[1]!));
    if (parsed.ok) return {
      report: parsed.value,
      body: [rawOutput.slice(0, last.index).trim(), rawOutput.slice(last.index + last[0].length).trim()].filter(Boolean).join('\n\n'),
    };
    logger.debug('Completion report footer read as plain text', { reason: parsed.reason });
  } catch (error) {
    logger.debug('Completion report fenced JSON parse failed', { error: summarizeError(error) });
  }
  return null;
}
