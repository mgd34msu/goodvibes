import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { StreamingCodeFenceFilter, stripMarkdownForSpeech } from './speech-markdown.js';
import { classicSpeechEndOffsets } from '../../../browser-decision-policy.js';

/**
 * Streaming speech policy: a reply is cut at its sentence ends, found by the
 * local punctuation splitter. A chunk is also released at the size cap (at a
 * word boundary) and, up to its last whole word, when text has waited
 * `maxLatencyMs`, so first audio never waits on anything but the text itself.
 * A chunk never ends inside a word except at the size cap when a single word
 * exceeds it, so the controller may join chunks with a space. A wrong cut
 * costs an odd pause; nothing is authorised on it.
 */
export interface TtsTextChunkerOptions {
  readonly minBoundaryChars?: number | undefined;
  readonly maxChunkChars?: number | undefined;
  readonly maxLatencyMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** How much already-received reply text is screened again together with each new delta. */
const RAW_SCREEN_WINDOW_CHARS = 4096;

export class TtsTextChunker {
  private buffer = '';
  // Tail of the received source (see RAW_SCREEN_WINDOW_CHARS), before markdown filtering.
  private raw = '';
  private firstBufferedAt: number | null = null;
  private readonly fenceFilter = new StreamingCodeFenceFilter();
  private readonly minBoundaryChars: number;
  private readonly maxChunkChars: number;
  private readonly maxLatencyMs: number;
  private readonly now: () => number;

  constructor(options: TtsTextChunkerOptions = {}) {
    this.minBoundaryChars = options.minBoundaryChars ?? 24;
    this.maxChunkChars = options.maxChunkChars ?? 320;
    this.maxLatencyMs = options.maxLatencyMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Add streamed text; returns the chunks that are now ready to speak. Throws
   * when the reply carries credential material, so a secret is never spoken
   * or sent to a voice provider. Only a bounded tail is re-screened: the
   * declarations the screen reads (KEY=value, URL userinfo, card digits, key
   * headers) show their sensitive part within a short span.
   */
  push(delta: string): string[] {
    if (!delta) return [];
    this.raw = this.raw.slice(-RAW_SCREEN_WINDOW_CHARS) + delta;
    snapshotJudgmentInput({ text: this.raw });
    const filtered = this.fenceFilter.push(delta);
    if (!filtered) return [];
    if (this.firstBufferedAt === null) this.firstBufferedAt = this.now();
    this.buffer += filtered;
    return this.drainReady(false);
  }

  /** Release text that has waited past the latency limit. */
  flushDue(): string[] {
    if (!this.buffer.trim() || this.firstBufferedAt === null || this.now() - this.firstBufferedAt < this.maxLatencyMs) return [];
    return this.drainReady(true);
  }

  /** End of turn: everything left, in chunks no larger than the cap. */
  flushAll(): string[] {
    this.buffer += this.fenceFilter.flush();
    const chunks: string[] = [];
    while (this.buffer.trim()) {
      const end = this.buffer.length > this.maxChunkChars
        ? this.findWordBoundaryBefore(this.maxChunkChars) || this.maxChunkChars : this.buffer.length;
      const chunk = this.takeChunk(end);
      if (chunk) chunks.push(chunk);
    }
    this.buffer = ''; this.firstBufferedAt = null;
    return chunks;
  }

  reset(): void {
    this.buffer = ''; this.raw = ''; this.firstBufferedAt = null;
    this.fenceFilter.reset();
  }

  private drainReady(forceLatencyFlush: boolean): string[] {
    const chunks: string[] = [];
    while (this.buffer.trim()) {
      if (this.firstBufferedAt !== null && this.now() - this.firstBufferedAt >= this.maxLatencyMs) forceLatencyFlush = true;
      const sentence = this.findLatestSentenceBoundary();
      const boundary = sentence > 0 ? sentence
        : this.buffer.length >= this.maxChunkChars ? this.findWordBoundaryBefore(this.maxChunkChars) || this.maxChunkChars
        // Stream deltas are tokens, so the buffer may end inside a word: the
        // latency release stops at the last whitespace and keeps the partial
        // word for the next piece. Every chunk is whole words.
        : forceLatencyFlush ? this.findWordBoundaryBefore(this.buffer.length) : -1;
      if (boundary <= 0) break;
      const chunk = this.takeChunk(boundary);
      if (chunk) chunks.push(chunk);
      forceLatencyFlush = false;
    }
    return chunks;
  }

  /** The last sentence end inside the size window that leaves a chunk worth a request. */
  private findLatestSentenceBoundary(): number {
    if (this.buffer.length < this.minBoundaryChars) return -1;
    return classicSpeechEndOffsets(this.buffer)
      .filter(end => end < this.buffer.length && end >= this.minBoundaryChars && end <= this.maxChunkChars).at(-1) ?? -1;
  }

  private findWordBoundaryBefore(index: number): number {
    for (let i = Math.min(index, this.buffer.length); i > 0; i--) if (/\s/.test(this.buffer[i - 1] ?? '')) return i;
    return 0;
  }

  private takeChunk(end: number): string {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    this.firstBufferedAt = this.buffer.trim() ? this.now() : null;
    return normalizeSpeechText(stripMarkdownForSpeech(raw));
  }
}

export function normalizeSpeechText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
