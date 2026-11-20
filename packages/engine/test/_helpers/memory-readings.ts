/**
 * A fake judgment port for the state layer's memory decisions
 * (platform/src/platform/state/batteries/*), so tests of memory search, knowledge
 * injection, consolidation and usage detection never call the live Jev API.
 *
 * Each decision is answered by a function of the request's state. The
 * defaults stand in for a model with simple rules that make readable test
 * scenarios read naturally: a record "matches" when it shares a word of four
 * or more letters with the query, task or response, and two records are the
 * same fact when their summaries are equal (then duplicates when their
 * details agree, contradictory when they differ, with neither a later
 * correction of the other), and any record not yet reviewed needs review. Tests that pin a specific
 * reading pass their own function.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { Question } from '@goodvibes/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';

export interface RecordText {
  readonly class?: string;
  readonly summary: string;
  readonly detail?: string;
  readonly tags?: readonly string[];
  readonly files?: readonly string[];
}

export interface RelevanceReading {
  readonly relevant: number;
  readonly taskMatch?: number;
  readonly scopeMatch?: number;
}

export interface PairReading {
  /** Alignment level: 0 distinct, 1 review, 2 same. */
  readonly link: 0 | 1 | 2;
  /** A boolean reads as a strong yes or no; a number is the probability itself. */
  readonly restates: boolean | number;
  readonly conflicts: boolean | number;
  /** Which record is a later correction of the other; 'neither' when absent. */
  readonly replaces?: 'a_replaces_b' | 'b_replaces_a' | 'neither';
  /** The replaces reading's confidence; 0.95 when absent. */
  readonly replacesConfidence?: number;
}

export interface MemoryReadingTable {
  readonly relevance?: (task: string, writeScope: readonly string[], record: RecordText) => RelevanceReading;
  readonly searchMatch?: (query: string, candidate: RecordText) => number;
  readonly usage?: (memory: RecordText, response: string) => number;
  readonly pair?: (a: RecordText, b: RecordText) => PairReading;
  /** Probability that a person should review the record (the review queue order). */
  readonly reviewPriority?: (record: RecordText & { readonly review_state: string; readonly confidence: number }) => number;
}

const YES = 0.95;
const NO = 0.05;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4));
}

function textOf(record: RecordText): string {
  return [record.summary, record.detail ?? '', ...(record.tags ?? []), ...(record.files ?? [])].join(' ');
}

/** Whether the two texts share a word of four or more letters. */
export function sharesWord(left: string, right: string): boolean {
  const rightWords = words(right);
  return [...words(left)].some((word) => rightWords.has(word));
}

/** The default answers, for a test that overrides one case and keeps the rest. */
export const DEFAULT_MEMORY_READINGS: Required<MemoryReadingTable> = {
  relevance: (task, writeScope, record) => {
    const taskMatch = sharesWord(task, textOf(record));
    const scopeMatch = sharesWord(writeScope.join(' '), textOf(record));
    return { relevant: taskMatch || scopeMatch ? YES : NO, taskMatch: taskMatch ? YES : NO, scopeMatch: scopeMatch ? YES : NO };
  },
  searchMatch: (query, candidate) => (sharesWord(query, textOf(candidate)) ? YES : NO),
  usage: (memory, response) => (sharesWord(textOf(memory), response) ? YES : NO),
  pair: (a, b) => {
    if (a.summary.toLowerCase() !== b.summary.toLowerCase()) return { link: 0, restates: false, conflicts: false };
    const same = (a.detail ?? '') === (b.detail ?? '') || !a.detail || !b.detail;
    return { link: 2, restates: same, conflicts: !same };
  },
  reviewPriority: (record) => (record.review_state === 'reviewed' ? NO : YES),
};

type State = Record<string, unknown>;

function answer(table: Required<MemoryReadingTable>, name: string, question: Question, state: State): unknown {
  if (name === 'completion_required') return noulAnswer(.99);
  if (['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission', 'repetitive', 'implementation_presented', 'verification_claimed', 'criteria_altered', 'ineffective_fix', 'irrelevant_verification', 'weakened_criteria', 'missing_results', 'unresolved_conflict'].includes(name)) return noulAnswer(.01);
  if ('query' in state && Array.isArray(state.candidates) && question.type === 'choice') {
    // A together rerank reads every candidate in one Choice: each candidate's
    // share against "none" is its yes reading. Which rerank it is shows in its
    // test line: memory usage, memory search, or knowledge injection.
    const test = String((question.instructions as { test?: unknown } | undefined)?.test ?? '');
    const query = state.query as string | { task: string; write_scope?: string[] };
    const task = typeof query === 'string' ? query : query.task;
    const scope = typeof query === 'string' ? [] : query.write_scope ?? [];
    const yesOf = (content: RecordText): number => test.includes('model response') ? table.usage(content, task)
      : test.includes('searched their project memory') ? table.searchMatch(task, content)
        : table.relevance(task, scope, content).relevant;
    const weights: Record<string, number> = { none: 1 };
    for (const candidate of state.candidates as { id: string; content: RecordText }[]) {
      const relevant = Math.min(0.999, Math.max(0.001, yesOf(candidate.content)));
      weights[candidate.id] = relevant / (1 - relevant);
    }
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    const probabilities = Object.fromEntries(Object.keys(question.criteria).map((option) => [option, (weights[option] ?? 0) / total]));
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
    return { type: 'choice', choice, confidence: 0.9, probabilities };
  }
  if ('task' in state && 'record' in state) {
    const reading = table.relevance(state.task as string, state.write_scope as string[], state.record as RecordText);
    if (name === 'relevant') return noulAnswer(reading.relevant);
    if (name === 'task_match') return noulAnswer(reading.taskMatch ?? NO);
    return noulAnswer(reading.scopeMatch ?? NO);
  }
  if ('record' in state) {
    return noulAnswer(table.reviewPriority(state.record as RecordText & { review_state: string; confidence: number }));
  }
  if ('query' in state && 'candidate' in state) {
    return noulAnswer(table.searchMatch(String(state.query), state.candidate as RecordText));
  }
  if ('memory' in state && 'response' in state) {
    return noulAnswer(table.usage(state.memory as RecordText, state.response as string));
  }
  if ('entity_a' in state) {
    const reading = table.pair(state.entity_a as RecordText, state.entity_b as RecordText);
    return scoreAnswer(question, reading.link, 0.95);
  }
  if ('record_a' in state) {
    const reading = table.pair(state.record_a as RecordText, state.record_b as RecordText);
    if (name === 'replaces') return choiceAnswer(question, reading.replaces ?? 'neither', reading.replacesConfidence ?? 0.95);
    const value = name === 'restates' ? reading.restates : reading.conflicts;
    return noulAnswer(typeof value === 'number' ? value : value ? YES : NO);
  }
  throw new Error(`memory readings port: no answer for question ${name}`);
}

/** A port answering the state memory decisions from `table`, recording every request. */
export function memoryReadingsPort(table: MemoryReadingTable = {}) {
  const merged: Required<MemoryReadingTable> = { ...DEFAULT_MEMORY_READINGS, ...table };
  return fakePort((name, question, state) => answer(merged, name, question, state as State));
}

/** One recorded request: its state, the questions asked and the decision it was asked for. */
export interface RecordedRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, unknown>>;
  readonly context?: { readonly battery?: string } | undefined;
}

/**
 * Installs a {@link memoryReadingsPort} around every test in the calling file
 * (or describe block) and restores the previous port afterwards. `requests` is
 * the current test's request log; `use` swaps in another table for one test.
 */
export function useMemoryReadings(table: MemoryReadingTable = {}): {
  readonly requests: readonly RecordedRequest[];
  use(next: MemoryReadingTable): void;
} {
  const log = {
    requests: [] as readonly RecordedRequest[],
    use(next: MemoryReadingTable) {
      const { port, requests } = memoryReadingsPort(next);
      log.requests = requests;
      installJudgmentPort(port);
    },
  };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port, requests } = memoryReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return log;
}
