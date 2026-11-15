/** One compaction pass owns these source-bound readings. No memo, provider-text
 * fallback, or diagnostic stores source bodies.
 *
 * Selection is linear in the conversation: the candidates of each section are
 * cut into bounded chunks, and one request per chunk asks which of that
 * chunk's messages to keep. Structural partners (the call behind a result, the
 * user turn behind a reply) come from code. A pass that would need more than
 * {@link COMPACTION_SELECTION_LIMITS}.maxCalls requests, runs past its
 * deadline, or cannot be read (no decision model, a malformed answer) quotes
 * the sections mechanically instead, the same way Classic operation does, so a
 * long session can always compact. Only the caller's own cancellation or a
 * changed source ends the pass with an error. */
import {
  estimateTokens as judgmentTokens, mapLimit, noul, readYesNo, recordAction, recordReadings,
  type NoulQuestion, type NoulResponse,
} from '@goodvibes-jev/judgment';
import type { ProviderMessage } from '../../providers/interface.js';
import type { ToolCall } from '../../types/tools.js';
import { OwnedJudgmentWork } from '../owned-judgment-work.js';
import { logger } from '../../utils/logger.js';
import { conversationSubstance, toolResultRelevance, resolvedProblemEvidence } from './batteries/section-selection.js';

import { checkedCompactionPort, CompactionReadingError } from './section-judgment.js';
export { CompactionReadingError } from './section-judgment.js';
import { isClassicOperation } from '../decision-policy.js';

type SelectionBattery = typeof conversationSubstance;

/** Bounds of one selection pass. Past any of them the sections are quoted mechanically. */
export const COMPACTION_SELECTION_LIMITS = Object.freeze({
  /** Estimated tokens of source one request carries. */
  chunkTokens: 8_000,
  /** Candidates one request asks about. */
  chunkCandidates: 24,
  /** Characters of one message shown to the reader; the rest is marked, never silently cut. */
  messageChars: 12_000,
  /** Requests one pass may send across all three sections. */
  maxCalls: 24,
  /** Wall time one pass may take before it quotes instead. */
  deadlineMs: 30_000,
});

/** The first path-like argument of a tool call, for naming what it touched. */
function callPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'cwd']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const key of ['files', 'paths', 'edits']) {
    const list = args[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const first: unknown = list[0];
    const path = typeof first === 'string' ? first
      : first && typeof first === 'object' ? callPath(first as Record<string, unknown>) : undefined;
    if (path) return list.length > 1 ? `${path} (+${list.length - 1} more)` : path;
  }
  return undefined;
}

/** A tool call as a compaction quotes it: name, the path it touched, and the size of its arguments. The arguments stay in saved history. */
function describeCall(call: ToolCall): string {
  const path = callPath(call.arguments);
  const size = JSON.stringify(call.arguments ?? {}).length;
  return `[call ${call.id}; ${call.name}${path ? ` ${path}` : ''}; ${size} chars of arguments]`;
}

function sourcePrefix(message: ProviderMessage): string {
  if (message.role === 'tool') return `[tool${message.name ? ` ${message.name}` : ''}; call ${message.callId}]: `;
  const calls = message.role === 'assistant' ? (message.toolCalls ?? []).map(describeCall).join('\n') : '';
  return `[${message.role}]: ${calls ? `\n${calls}\n` : ''}`;
}
function body(message: ProviderMessage): string {
  return typeof message.content === 'string' ? message.content.trim() : message.content.map(part => {
    if (part.type === 'text') return part.text;
    // Text-only readers cannot qualify image meaning, but one image must not
    // make the whole conversation uncompactable: it is read, and quoted if
    // selected, as a marker for what the text cannot carry.
    return '[image: not quoted in this text excerpt]';
  }).join('');
}
function render(message: ProviderMessage): string {
  return sourcePrefix(message) + body(message);
}
/** A message as one selection request shows it: whole up to a size, then marked. */
function renderForReading(message: ProviderMessage, position: number): string {
  const text = render(message);
  const cap = COMPACTION_SELECTION_LIMITS.messageChars;
  return `#${position} ${text.length <= cap ? text : `${text.slice(0, cap)} [${text.length - cap} more characters]`}`;
}

/** Mechanical quoting: source text in order, cut in the middle with a visible marker. Claims nothing about meaning. */
function quoteSections(input: SectionInput): SectionText {
  const quote = (messages: readonly ProviderMessage[], budget: number): string => {
    const count = Math.max(0, Math.floor(budget * 4));
    if (!count || !messages.length) return '';
    const full = messages.map(render).join('\n\n');
    if (full.length <= count) return full;
    const marker = '\n[Excerpt clipped; consult saved conversation history for omitted text.]\n';
    const available = Math.max(0, count - marker.length);
    const head = Math.ceil(available / 2), tail = available - head;
    return full.slice(0, head) + marker + (tail ? full.slice(-tail) : '');
  };
  return {
    conversation: quote(input.messages.filter(message => message.role === 'user' || message.role === 'assistant'), input.conversationBudget),
    tools: quote(input.messages.filter(message => message.role === 'tool'), input.toolBudget),
    problems: '',
  };
}

/**
 * Quote the selected messages in source order within the budget. When they do
 * not all fit, the newest are kept whole and the older ones are left out with a
 * visible count; a newest line that alone is over the budget is clipped and
 * marked. Never throws: a section over its budget is shortened, not abandoned.
 */
export function renderSelected(messages: readonly ProviderMessage[], selected: ReadonlySet<number>, budgetTokens: number): string {
  const lines = messages.filter((_, index) => selected.has(index)).map(render);
  const budget = Math.max(0, budgetTokens * 4);
  const joined = lines.join('\n\n');
  if (joined.length <= budget) return joined;
  const omittedMarker = (count: number) => `[${count} earlier line${count === 1 ? '' : 's'} omitted]`;
  const reserve = omittedMarker(lines.length).length + 2;
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cost = line.length + (kept.length > 0 ? 2 : 0);
    if (used + cost <= budget - reserve) { kept.unshift(line); used += cost; continue; }
    if (kept.length === 0) {
      const clipped = ' [clipped]';
      const room = budget - reserve - clipped.length;
      if (room > 0) { kept.unshift(line.slice(0, room) + clipped); used += room + clipped.length; }
    }
    break;
  }
  const omitted = lines.length - kept.length;
  return omitted > 0 ? [omittedMarker(omitted), ...kept].join('\n\n') : kept.join('\n\n');
}

/** Structural source relations, independent of semantic inclusion. */
function sourcePartners(messages: readonly ProviderMessage[]): (index: number) => readonly number[] {
  const links = new Map<number, Set<number>>(); const calls = new Map<string, number>();
  const link = (from: number, to: number) => { const found = links.get(from) ?? new Set<number>(); found.add(to); links.set(from, found); };
  let user = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') user = index;
    if (message.role === 'assistant') {
      if (user >= 0) link(index, user);
      for (const call of message.toolCalls ?? []) calls.set(call.id, index);
    }
    if (message.role === 'tool') {
      const owner = calls.get(message.callId);
      if (owner !== undefined) { link(index, owner); link(owner, index); }
    }
  });
  return index => {
    const seen = new Set<number>([index]); const pending = [index];
    for (const current of pending) for (const next of links.get(current) ?? []) {
      if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
    return [...seen];
  };
}

interface SectionInput {
  readonly messages: readonly ProviderMessage[];
  readonly gathered: readonly ProviderMessage[];
  readonly conversationBudget: number;
  readonly toolBudget: number;
  readonly problemsBudget: number;
}
interface SectionText { conversation: string; tools: string; problems: string }

/** One request's worth of candidates: positions in `candidates` and the text the reader sees. */
interface Chunk { readonly battery: SelectionBattery; readonly group: number; readonly members: readonly number[]; readonly conversation: string }

function chunkCandidates(battery: SelectionBattery, group: number, candidates: readonly ProviderMessage[], source: readonly ProviderMessage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let members: number[] = []; let lines: string[] = []; let tokens = 0;
  const flush = () => { if (members.length) chunks.push({ battery, group, members, conversation: lines.join('\n\n') }); members = []; lines = []; tokens = 0; };
  candidates.forEach((candidate, index) => {
    const line = renderForReading(candidate, source.indexOf(candidate) + 1);
    const cost = judgmentTokens(line) + 20;
    if (members.length && (tokens + cost > COMPACTION_SELECTION_LIMITS.chunkTokens || members.length >= COMPACTION_SELECTION_LIMITS.chunkCandidates)) flush();
    members.push(index); lines.push(line); tokens += cost;
  });
  flush();
  return chunks;
}

/** Ask one chunk which of its messages to keep. An unsure reading keeps the message. */
async function readChunk(chunk: Chunk, candidates: readonly ProviderMessage[], source: readonly ProviderMessage[], owner: OwnedJudgmentWork, work: OwnedJudgmentWork): Promise<number[]> {
  const questions: Record<string, NoulQuestion> = {};
  for (const index of chunk.members) {
    questions[`selected_${index}`] = noul({ instructions: chunk.battery.items.selected.question.instructions ?? '',
      candidateSourcePosition: source.indexOf(candidates[index]!) + 1 });
  }
  const port = checkedCompactionPort(owner.options(chunk.battery.name).port!, work);
  const result = await work.wait(() => chunk.battery.askBatch(port, { conversation: chunk.conversation }, questions, {
    site: chunk.battery.name, signal: work.signal, beforeAttempt: work.assertCurrent,
  }));
  work.assertCurrent();
  const readings = Object.fromEntries(Object.keys(questions).map(key => [key, readYesNo(result.answers[key] as NoulResponse, chunk.battery.items.selected.band)]));
  recordReadings(port, result, readings);
  recordAction(port, result.decisionId, 'qualify-section-membership');
  return chunk.members.filter(index => readings[`selected_${index}`]!.verdict !== 'no');
}

export async function readCompactionSections(input: SectionInput, work: OwnedJudgmentWork): Promise<SectionText> {
  if (isClassicOperation()) {
    work.assertCurrent();
    const result = quoteSections(input);
    work.assertCurrent();
    return result;
  }
  const partners = sourcePartners(input.messages);
  const tools = input.messages.filter(message => message.role === 'tool');
  const exchanges = input.messages.filter(message => message.role === 'user' || message.role === 'assistant');
  const groups = [
    { battery: conversationSubstance, candidates: input.gathered },
    { battery: toolResultRelevance, candidates: tools },
    { battery: resolvedProblemEvidence, candidates: exchanges },
  ];
  const chunks = groups.flatMap(({ battery, candidates }, group) => chunkCandidates(battery, group, candidates, input.messages));
  const fallBack = (reason: string): SectionText => {
    work.assertCurrent();
    logger.warn('Compaction quoted its sections instead of selecting them', { reason, chunks: chunks.length });
    return quoteSections(input);
  };
  if (chunks.length > COMPACTION_SELECTION_LIMITS.maxCalls) {
    return fallBack(`selection would need ${chunks.length} requests, over the limit of ${COMPACTION_SELECTION_LIMITS.maxCalls}`);
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new CompactionReadingError('budget')), COMPACTION_SELECTION_LIMITS.deadlineMs);
  timer.unref?.();
  const pass = new OwnedJudgmentWork({ signal: AbortSignal.any([work.signal, deadline.signal]), assertCurrent: work.assertCurrent });
  try {
    const kept = await mapLimit(chunks, 4, chunk => readChunk(chunk, groups[chunk.group]!.candidates, input.messages, work, pass));
    work.assertCurrent();
    const selections = groups.map((_, group) => new Set(chunks.flatMap((chunk, index) => chunk.group === group ? kept[index]! : [])));
    const [recent, relevant, resolved] = selections as [Set<number>, Set<number>, Set<number>];
    // Keep complete structural partners even when gathering began mid-exchange.
    const expanded = (candidates: readonly ProviderMessage[], selected: ReadonlySet<number>) => new Set([...selected].flatMap(index =>
      partners(input.messages.indexOf(candidates[index]!))));
    return {
      conversation: renderSelected(input.messages, expanded(input.gathered, recent), input.conversationBudget),
      tools: renderSelected(input.messages, expanded(tools, relevant), input.toolBudget),
      problems: renderSelected(exchanges, resolved, input.problemsBudget),
    };
  } catch (error) {
    // The caller's cancellation or a changed source is the caller's to report.
    work.assertCurrent();
    // Never log provider exception bodies (they can echo private source).
    const reason = deadline.signal.aborted
      ? `selection ran past ${COMPACTION_SELECTION_LIMITS.deadlineMs / 1000}s`
      : error instanceof CompactionReadingError ? `selection ${error.reason}` : 'selection unavailable';
    return fallBack(reason);
  } finally {
    clearTimeout(timer);
    pass.retire();
  }
}
