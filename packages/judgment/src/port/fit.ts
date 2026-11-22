import type { EntryType, JsonValue, Questions } from './types.ts';

/**
 * Fitting one judgment request to what its decision targets accept.
 *
 * A request whose state and questions fit is sent whole. One that does not is
 * split by question: questions that fit beside the whole state go together in
 * as few requests as fit, and each question that does not fit even alone is
 * asked with the parts of the state most related to it. Parts are chosen, not
 * cut: the state is read as a tree of array items, object fields and text
 * segments, each part scored by the question's words it holds (rarer words
 * weigh more), and the least related parts are left out first, largest first,
 * until the state fits. Every part left out is marked where it was, so the
 * model knows what it did not see; the host keeps the complete evidence.
 */

/** One request of a split: a state and the questions asked about it. */
export interface JudgmentPart {
  readonly state: EntryType;
  readonly questions: Questions;
}

/** What every target of a port accepts. */
export interface RequestLimit {
  /** Whether this state and these questions go in one request every target accepts. */
  fits(state: EntryType, questions: Questions): boolean;
  /** About how many characters of state fit beside these questions. */
  stateChars(questions: Questions): number;
}

/** Text longer than this is read as segments, so the part of it that matters can stay. */
const SEGMENT_FROM = 1_500;
const SEGMENT_CHARS = 1_200;
/** Object fields smaller than this always stay. */
const FIELD_FROM = 120;
/** What a marker that replaces a part costs, about. */
const MARKER_CHARS = 64;

export const LEFT_OUT_KEY = 'requestLimit';
export const LEFT_OUT_NOTE = 'Parts marked "left out of this request" did not fit in one request to the decision model and were the parts least related to this question. They exist; the host keeps the complete evidence. Do not read a left-out part as missing work.';

type Shape =
  | { readonly kind: 'leaf'; readonly id: number }
  | { readonly kind: 'text'; readonly id: number; readonly segments: readonly { readonly id: number; readonly text: string }[] }
  | { readonly kind: 'array'; readonly id: number; readonly items: readonly Shape[] }
  | { readonly kind: 'object'; readonly id: number; readonly fields: readonly (readonly [string, Shape | null])[] };

interface Node {
  readonly parent: number;
  size: number;
  children: number;
  words: ReadonlySet<string>;
}

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'not', 'but', 'its', 'has', 'have', 'been',
  'any', 'all', 'each', 'which', 'what', 'when', 'where', 'does', 'did', 'into', 'than', 'then', 'them', 'they', 'their', 'there', 'these',
  'those', 'such', 'only', 'also', 'more', 'most', 'other', 'some', 'can', 'may', 'must', 'should', 'would', 'could', 'will', 'yes', 'true',
  'false', 'null', 'about', 'over', 'under', 'between', 'after', 'before', 'because', 'while', 'your', 'you', 'our', 'how', 'who', 'why',
  'both', 'either', 'same', 'very', 'just', 'like', 'one', 'two', 'answer', 'question', 'state']);

const WORD = /[a-z0-9_$][a-z0-9_$./-]*[a-z0-9_$]/g;

/** The distinct words of `text` worth matching: three characters or more, path parts too. */
export function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (word.length >= 3 && !STOP.has(word)) words.add(word);
    if (/[./-]/.test(word)) for (const part of word.split(/[./-]+/)) if (part.length >= 3 && !STOP.has(part)) words.add(part);
  }
  return words;
}

/** Segments of at most SEGMENT_CHARS, broken at line ends where a line allows it. */
function segmentsOf(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (current.length + line.length <= SEGMENT_CHARS) { current += line; continue; }
    if (current) segments.push(current);
    current = '';
    if (line.length <= SEGMENT_CHARS) { current = line; continue; }
    // A single line longer than a segment is read in pieces of a segment each.
    for (let start = 0; start < line.length; start += SEGMENT_CHARS) segments.push(line.slice(start, start + SEGMENT_CHARS));
  }
  if (current) segments.push(current);
  return segments;
}

/** The state as a tree of parts that can be left out, each with its size and words. */
class StateIndex {
  readonly nodes: Node[] = [];
  readonly root: Shape;
  readonly rootSize: number;

  constructor(readonly state: EntryType) {
    const built = this.build(state as JsonValue, -1);
    this.root = built.shape;
    this.rootSize = built.size;
  }

  private add(parent: number, size: number, words: ReadonlySet<string>): number {
    this.nodes.push({ parent, size, children: 0, words });
    if (parent >= 0) this.nodes[parent]!.children += 1;
    return this.nodes.length - 1;
  }

  private build(value: JsonValue, parent: number): { readonly shape: Shape; readonly size: number } {
    if (typeof value === 'string' && value.length > SEGMENT_FROM) {
      const size = JSON.stringify(value).length;
      const id = this.add(parent, size, new Set());
      const segments = segmentsOf(value).map(text => ({ id: this.add(id, text.length, wordsOf(text)), text }));
      return { shape: { kind: 'text', id, segments }, size };
    }
    if (Array.isArray(value)) {
      const id = this.add(parent, 0, new Set());
      const items: Shape[] = [];
      let size = 2 + Math.max(0, value.length - 1);
      for (const item of value) { const built = this.build(item, id); items.push(built.shape); size += built.size; }
      this.nodes[id]!.size = size;
      return { shape: { kind: 'array', id, items }, size };
    }
    if (value !== null && typeof value === 'object') {
      const kept: string[] = [];
      const id = this.add(parent, 0, new Set());
      const fields: (readonly [string, Shape | null])[] = [];
      const entries = Object.entries(value);
      let size = 2 + Math.max(0, entries.length - 1);
      for (const [key, field] of entries) {
        size += JSON.stringify(key).length + 1;
        const text = field !== null && typeof field === 'object' ? undefined : JSON.stringify(field);
        if (text !== undefined && text.length < FIELD_FROM) { fields.push([key, null]); kept.push(key, text); size += text.length; continue; }
        const built = this.build(field, id);
        fields.push([key, built.shape]);
        size += built.size;
      }
      const node = this.nodes[id]!;
      node.size = size;
      node.words = wordsOf(kept.join(' '));
      return { shape: { kind: 'object', id, fields }, size };
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
    const size = typeof value === 'string' ? JSON.stringify(value).length : text.length;
    return { shape: { kind: 'leaf', id: this.add(parent, size, wordsOf(text)) }, size };
  }
}

/** A min-heap of node ids by score, then by size, largest first. */
class Candidates {
  private readonly heap: number[] = [];
  constructor(private readonly score: Float64Array, private readonly size: Float64Array) {}
  private before(a: number, b: number): boolean {
    return this.score[a]! < this.score[b]! || (this.score[a] === this.score[b] && this.size[a]! > this.size[b]!);
  }
  push(id: number): void {
    const heap = this.heap;
    heap.push(id);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  }
  pop(): number | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1, right = left + 1;
        let next = index;
        if (left < heap.length && this.before(heap[left]!, heap[next]!)) next = left;
        if (right < heap.length && this.before(heap[right]!, heap[next]!)) next = right;
        if (next === index) break;
        [heap[index], heap[next]] = [heap[next]!, heap[index]!];
        index = next;
      }
    }
    return top;
  }
}

function itemsMarker(count: number): string {
  return `[${count} item${count === 1 ? '' : 's'} left out of this request]`;
}

function render(shape: Shape, value: JsonValue, left: ReadonlySet<number>): JsonValue {
  switch (shape.kind) {
    case 'leaf': return value;
    case 'text': {
      let text = '', out = 0;
      for (const segment of shape.segments) {
        if (left.has(segment.id)) { out += segment.text.length; continue; }
        if (out > 0) { text += `[… ${out} characters left out of this request …]\n`; out = 0; }
        text += segment.text;
      }
      if (out > 0) text += `[… ${out} characters left out of this request …]`;
      return text;
    }
    case 'array': {
      const items = value as JsonValue[];
      const out: JsonValue[] = [];
      let run = 0;
      shape.items.forEach((item, index) => {
        if (left.has(item.id)) { run += 1; return; }
        if (run > 0) { out.push(itemsMarker(run)); run = 0; }
        out.push(render(item, items[index]!, left));
      });
      if (run > 0) out.push(itemsMarker(run));
      return out;
    }
    case 'object': {
      const object = value as { readonly [key: string]: JsonValue };
      return Object.fromEntries(shape.fields.map(([key, field]) => [key,
        field === null ? object[key]! : left.has(field.id) ? '[left out of this request]' : render(field, object[key]!, left)]));
    }
  }
}

/**
 * The state with the parts least related to `focus` left out until it fits:
 * `fits` decides, `targetChars` says about where to stop and check. Returns the
 * state unchanged when it already fits.
 */
function fitState(index: StateIndex, focus: ReadonlySet<string>, targetChars: number, fits: (state: EntryType) => boolean): EntryType {
  const { nodes } = index;
  const count = nodes.length;
  // How rare each of the question's words is among the parts: a rare word says more about relevance.
  const leaves = nodes.filter(node => node.children === 0).length || 1;
  const weight = new Map<string, number>();
  for (const word of focus) {
    let frequency = 0;
    for (const node of nodes) if (node.children === 0 && node.words.has(word)) frequency += 1;
    if (frequency > 0) weight.set(word, Math.log(1 + leaves / frequency));
  }
  const score = new Float64Array(count), size = new Float64Array(count);
  const remaining = new Int32Array(count);
  for (let id = 0; id < count; id++) {
    const node = nodes[id]!;
    size[id] = node.size;
    remaining[id] = node.children;
    let total = 0;
    for (const [word, value] of weight) if (node.words.has(word)) total += value;
    score[id] = total;
  }
  const candidates = new Candidates(score, size);
  for (let id = 1; id < count; id++) if (nodes[id]!.children === 0) candidates.push(id);
  const left = new Set<number>();
  let total = index.rootSize;
  let target = targetChars;
  for (;;) {
    while (total > target) {
      const id = candidates.pop();
      if (id === undefined) break;
      left.add(id);
      const saved = Math.max(0, size[id]! - MARKER_CHARS);
      total -= saved;
      for (let parent = nodes[id]!.parent; parent >= 0; parent = nodes[parent]!.parent) size[parent] = size[parent]! - saved;
      const parent = nodes[id]!.parent;
      // A container whose every part is left out is itself a part that can go.
      if (parent > 0) { remaining[parent] = remaining[parent]! - 1; if (remaining[parent] === 0) candidates.push(parent); }
    }
    const rendered = left.size === 0 ? index.state : withNote(render(index.root, index.state as JsonValue, left));
    if (fits(rendered as EntryType)) return rendered as EntryType;
    // Nothing more can go: the smallest state there is goes, and the target decides.
    if (total <= MARKER_CHARS || target < 1) return rendered as EntryType;
    target = Math.min(target, total) * 0.85;
  }
}

function withNote(value: JsonValue): JsonValue {
  if (typeof value === 'string') return `${LEFT_OUT_NOTE}\n\n${value}`;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, LEFT_OUT_KEY)) return { [LEFT_OUT_KEY]: LEFT_OUT_NOTE, ...value };
  return value;
}

/**
 * The requests one judgment request is sent as, or undefined when it fits
 * whole. Questions that fit beside the whole state are asked together, in as
 * few requests as fit; each question that does not fit even alone is asked
 * with the parts of the state most related to it.
 */
export function partitionJudgmentInput(state: EntryType, questions: Questions, limit: RequestLimit): readonly JudgmentPart[] | undefined {
  if (limit.fits(state, questions)) return undefined;
  const names = Object.keys(questions);
  const parts: JudgmentPart[] = [];
  const alone: string[] = [];
  let batch: Record<string, Questions[string]> = {};
  for (const name of names) {
    const single = { [name]: questions[name]! };
    if (!limit.fits(state, single)) { alone.push(name); continue; }
    const grown = { ...batch, [name]: questions[name]! };
    if (Object.keys(batch).length === 0 || limit.fits(state, grown)) { batch = grown; continue; }
    parts.push({ state, questions: batch });
    batch = single;
  }
  if (Object.keys(batch).length > 0) parts.push({ state, questions: batch });
  if (alone.length > 0) {
    const index = new StateIndex(state);
    for (const name of alone) {
      const single: Questions = { [name]: questions[name]! };
      const fitted = fitState(index, wordsOf(JSON.stringify(questions[name])), limit.stateChars(single), candidate => limit.fits(candidate, single));
      parts.push({ state: fitted, questions: single });
    }
  }
  return parts;
}
