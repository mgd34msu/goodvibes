import { isDeepStrictEqual } from 'node:util';
import type { VerificationOrigin, VerificationSource, VerificationSourceInput, VerificationSourceOwner } from './types.js';

export const VERIFICATION_FRAME_CHARACTERS = 28_000;
export const VERIFICATION_OVERVIEW_CHARACTERS = 16_000;
let recordNamespace: string | undefined;
let recordSequence = 0;

/** An issued record identity, never a digest of source text or an approval.
 * Keep native random identity bytes out of the numeric-material alphabet.
 * A persistent source owner reuses the actual retained record when unchanged.
 */
export function issueVerificationId(kind: 's' | 'index' | 'e' | 'proposal' | 'history' | 'message' | 'context' | 'original' | 'repair'): string {
  recordNamespace ??= crypto.randomUUID().replace(/\d/g, digit => 'ghijklmnop'[Number(digit)]!);
  recordSequence++;
  if (!Number.isSafeInteger(recordSequence)) throw new Error('Verification record identity exhausted');
  return `${kind}-${recordNamespace}-${recordSequence.toString(36)}`;
}
export function issueVerificationSource(source: VerificationSourceInput): VerificationSource {
  return { ...source, id: issueVerificationId('s') };
}

/** Host call IDs select a small bucket; exact metadata decides membership.
 * Grouping grants no authority and never hashes arguments or returned text.
 */
export function verificationExecutionGroups(sources: readonly VerificationSource[]) {
  type Group = { execution: NonNullable<VerificationSource['execution']>; sources: VerificationSource[] };
  const ordered: Group[] = [], byCall = new Map<string, Group[]>();
  const find = (execution: VerificationSource['execution']) => typeof execution?.callId === 'string'
    ? byCall.get(execution.callId)?.find(group => isDeepStrictEqual(group.execution, execution)) : undefined;
  for (const source of sources) {
    const execution = source.execution;
    if (typeof execution?.callId !== 'string') continue;
    let group = find(execution);
    if (!group) {
      group = { execution, sources: [] }; ordered.push(group);
      const bucket = byCall.get(execution.callId) ?? []; bucket.push(group); byCall.set(execution.callId, bucket);
    }
    group.sources.push(source);
  }
  return { groups: ordered.map(group => group.sources), has: (execution: VerificationSource['execution']) => find(execution) !== undefined };
}

/**
 * The message a source came from, written from its origin fields: the lane and
 * its position (`transcript[3]`, `delegated w1.evidence[0]`). The one place a
 * label is made from those facts; a source with no origin fields keeps the head
 * of its reference.
 */
export function verificationOriginLabel(source: Pick<VerificationSource, keyof VerificationOrigin | 'reference'>): string {
  const at = source.messageIndex === undefined ? '' : `[${source.messageIndex}]`;
  switch (source.lane) {
    case 'request': return 'current user request';
    case 'criteria': return 'host acceptance criteria, subordinate to original user scope';
    case 'turn-entry-request': return 'original request at turn entry';
    case 'transcript': return `transcript${at}`;
    case 'initial-transcript': return `initial.transcript${at}`;
    case 'archive': return `original history before compaction ${source.archiveIndex ?? 0}${at}`;
    case 'delegated-assignment': return `delegated assignment/result ${source.workerId ?? 'unknown'}`;
    case 'delegated-evidence': return `delegated ${source.workerId ?? 'unknown'}.evidence${at}`;
    case 'contract': return `host completed contract ${source.contractId ?? 'unavailable'}`;
    case 'contract-acceptance': return `host completed contract ${source.contractId ?? 'unavailable'}; acceptance and publication`;
    case 'contract-answer': return `host completed contract ${source.contractId ?? 'unavailable'}; exact saved answer`;
    case 'answer': return 'exact proposed answer, not an execution observation';
    default: return source.reference.split(';')[0]!;
  }
}

/** Every byte belongs to an identified source interval. Boundaries are visible;
 * no middle is dropped and a fragment never claims to be a whole observation. */
export function verificationSources(state: Record<string, unknown>, own: VerificationSourceOwner = issueVerificationSource): VerificationSource[] {
  const result: VerificationSource[] = [];
  const add = (kind: VerificationSource['kind'], origin: VerificationOrigin, detail: string | undefined, value: unknown, messageRole?: VerificationSource['messageRole'], execution?: VerificationSource['execution'], toolCallIds?: readonly string[]) => {
    const reference = `${verificationOriginLabel({ ...origin, reference: '' })}${detail ? `; ${detail}` : ''}`;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 12_000);
      while (JSON.stringify(text.slice(start, end)).length > VERIFICATION_FRAME_CHARACTERS / 2) end = start + Math.max(1, Math.floor((end - start) / 2));
      // A cut inside a long numeric identity can manufacture a 13–19 digit
      // card shape that did not exist in the admitted original. Keep ordinary
      // runs intact. For a run larger than a frame, keep both resulting groups
      // longer than the card limit. Every resulting source is still screened.
      const digit = (index: number) => index >= 0 && index < text.length && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57;
      if (digit(end - 1) && digit(end)) {
        let beginning = end;
        while (beginning > start && digit(beginning - 1)) beginning--;
        if (beginning > start) end = beginning;
        else {
          let tail = 0;
          while (tail < 20 && digit(end + tail)) tail++;
          if (tail < 20) end -= 20 - tail;
        }
      }
      const label = `${reference}; ${start === 0 && end === text.length ? 'complete source' : 'partial source'}; characters ${start}..${end} of ${text.length}`;
      result.push(own({ kind, reference: label, ...origin, text: text.slice(start, end),
        ...(messageRole ? { messageRole, completeMessage: start === 0 && end === text.length } : {}), ...(execution ? { execution } : {}), ...(toolCallIds?.length ? { toolCallIds } : {}) }));
      start = end;
    }
  };
  add('instruction', { lane: 'request' }, undefined, state.request);
  if (state.requirements != null) add('instruction', { lane: 'criteria' }, undefined, state.requirements);
  const seenExecutions = new Map<string, string[]>();
  const mainCalls = new Map<string, { id: string; name?: string; arguments?: unknown }>();
  const transcript = (messages: unknown, origin: VerificationOrigin, callContext = new Map<string, { id: string; name?: string; arguments?: unknown }>(), lane = 'main', originalInstructions = true) => {
    if (!Array.isArray(messages)) return;
    messages.forEach((message: Record<string, unknown>, index) => {
      const calls = message.toolCalls as { id: string; name?: string; arguments?: unknown }[] | undefined;
      if (message.role === 'assistant') for (const call of calls ?? []) if (typeof call.id === 'string') callContext.set(call.id, call);
      const identity = message.role === 'tool' ? message.callId : calls?.map(call => call.id);
      const serializedMessage = JSON.stringify(message);
      if (identity) {
        // Only a repeated snapshot of the SAME execution is redundant. Equal
        // queries with different call IDs (including A B A) remain distinct.
        const key = JSON.stringify([lane, identity]);
        const previous = seenExecutions.get(key) ?? [];
        if (previous.includes(serializedMessage)) return;
        previous.push(serializedMessage); seenExecutions.set(key, previous);
      }
      const role = ['user', 'assistant', 'tool', 'system'].includes(String(message.role)) ? message.role as VerificationSource['messageRole'] : undefined;
      const call = message.role === 'tool' && typeof message.callId === 'string' ? callContext.get(message.callId) : undefined;
      const execution = message.role === 'tool' ? { callId: message.callId, outcome: message.outcome ?? 'unknown', ...(call ? { tool: call.name,
        ...(JSON.stringify(call.arguments ?? null).length <= 2_000 ? { exactArguments: call.arguments ?? null } : { argumentsSource: `Original assistant call ${call.id}; arguments are retained separately, not clipped or inferred.` }) } : {}) } : undefined;
      add(originalInstructions && message.role === 'user' ? 'instruction' : 'observation', { ...origin, messageIndex: index }, `role ${message.role}`, serializedMessage, role, execution, message.role === 'assistant' ? calls?.map(call => call.id) : undefined);
    });
  };
  const archive = state.archive as readonly { messages: unknown }[] | undefined;
  archive?.forEach((entry, index) => transcript(entry.messages, { lane: 'archive', archiveIndex: index }, mainCalls));
  const initial = state.initial as { request?: unknown; transcript?: unknown } | null;
  if (initial) {
    add('instruction', { lane: 'turn-entry-request' }, undefined, initial.request);
    const current = state.transcript as readonly unknown[];
    const before = initial.transcript;
    if (!Array.isArray(before) || !before.every((message, index) => JSON.stringify(message) === JSON.stringify(current[index]))) transcript(before, { lane: 'initial-transcript' }, mainCalls);
  }
  transcript(state.transcript, { lane: 'transcript' }, mainCalls);
  for (const agent of (state.delegated ?? []) as Record<string, unknown>[]) {
    const workerId = String(agent.id);
    add('observation', { lane: 'delegated-assignment', workerId }, undefined, { ...agent, evidence: undefined });
    transcript(agent.evidence, { lane: 'delegated-evidence', workerId }, new Map(), `delegated:${workerId}`, false);
  }
  for (const work of (state.completedWork ?? []) as Record<string, unknown>[]) {
    const contractId = work.id === undefined ? undefined : String(work.id);
    const contract = { ...(contractId === undefined ? {} : { contractId }) };
    add('observation', { lane: 'contract', ...contract }, 'scoped checks and publication, not final response approval', work);
    if (work.kind === 'host-completed-contract') {
      // Keep the full record above. Also expose its exact acceptance fields as
      // an independently retrievable primary, so a long answer/unit history
      // cannot bury the scope, actual final check or publication outcome.
      const { units: _units, answer: _answer, ...acceptance } = work;
      add('observation', { lane: 'contract-acceptance', ...contract }, undefined, acceptance);
      if (typeof work.answer === 'string') add('observation', { lane: 'contract-answer', ...contract }, undefined, {
        kind: 'host-saved-contract-answer', id: work.id, answer: work.answer,
        contentReview: work.contentReview, goalCoverage: work.goalCoverage,
        meaning: 'Exact saved result whose native review bindings are supplied beside it. This is the prior checked result, not the current proposed answer, user instructions or a new completion permit.',
      });
    }
  }
  if (typeof state.response === 'string' && JSON.stringify(state.response).length > 12_000) add('answer', { lane: 'answer' }, undefined, state.response);
  return result;
}

/** Exact run encoding, not a summary: joining every segment count times
 * reconstructs the original code units, including escaped JSON newlines. */
export function verificationWireSource(source: VerificationSource) {
  const { messageRole: _localRole, completeMessage: _localBoundary, originalIds: _localOrigins, readKind: _localReadKind,
    lane: _lane, archiveIndex: _archiveIndex, messageIndex: _messageIndex, workerId: _workerId, contractId: _contractId, ...wire } = source;
  const segments = source.text.split(/(?<=\n)|(?<=\\n)/u);
  const runs: { text: string; count: number }[] = [];
  for (const text of segments) {
    const last = runs.at(-1);
    if (last?.text === text) last.count++; else runs.push({ text, count: 1 });
  }
  const encoded = { encoding: 'lossless consecutive segment runs; concatenate text repeated count times, without separators', codeUnits: source.text.length, runs };
  if (JSON.stringify(encoded).length < JSON.stringify(source.text).length * .7) {
    // A retained owner supplies immutable execution metadata. Its newly built
    // lossless text view must be immutable as well before another guard owns it.
    runs.forEach(run => Object.freeze(run)); Object.freeze(runs); Object.freeze(encoded);
    return Object.freeze({ ...wire, text: encoded });
  }
  return Object.freeze(wire);
}

export function verificationFrames<T>(values: readonly T[], limit = VERIFICATION_FRAME_CHARACTERS, sizeOf = (value: T) => JSON.stringify(value).length): T[][] {
  const groups: T[][] = []; let group: T[] = [], length = 0;
  for (const value of values) {
    const size = sizeOf(value);
    if (size > limit) throw new Error('Verification source exceeds its native frame size');
    if (group.length && length + size > limit) { groups.push(group); group = []; length = 0; }
    group.push(value); length += size;
  }
  if (group.length) groups.push(group);
  return groups;
}
