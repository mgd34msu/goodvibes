/** Browser-safe policy observations and Classic presentation helpers. No model port is imported. */
import { readDecisionModelPolicyHeader, type DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';
export { DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
export type { DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';

/** One selected host/account owns an observation. Reset on identity or transport changes. */
export class BrowserDecisionPolicy {
  #state: DecisionModelPolicyState | undefined;
  readonly #listeners = new Set<() => void>();
  readonly snapshot = (): DecisionModelPolicyState | undefined => this.#state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  };
  reset(): void { if (this.#state) { this.#state = undefined; this.changed(); } }
  observe(headers: Pick<Headers, 'get'>): void {
    const next = readDecisionModelPolicyHeader(headers);
    if (!next || JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next; this.changed();
  }
  private changed(): void { for (const listener of this.#listeners) listener(); }
}

/** Stable lexical matching of already-visible commands. Scores are not model confidence. */
export function classicCommandIndices(query: string, commands: readonly {
  readonly title: string; readonly id: string; readonly group: string; readonly keywords?: readonly string[];
}[]): readonly number[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return commands.map((command, index) => {
    const title = command.title.toLocaleLowerCase();
    const fields = [title, command.id, command.group, ...command.keywords ?? []].join(' ').toLocaleLowerCase();
    return { index, match: words.every(word => fields.includes(word)), order: title.startsWith(words.join(' ')) ? 0 : 1 };
  }).filter(item => item.match).sort((a, b) => a.order - b.order || a.index - b.index).map(item => item.index);
}

/** Local punctuation boundaries for playback; never presented as semantic sentence verification. */
export function classicSpeechEndOffsets(paragraph: string): readonly number[] {
  const offsets = [...paragraph.matchAll(/[.!?。！？]["')\]]*(?=\s|$)/gu)].map(match => match.index + match[0].length);
  if (offsets.at(-1) !== paragraph.length) offsets.push(paragraph.length);
  return offsets;
}
