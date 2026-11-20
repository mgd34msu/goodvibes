/**
 * One codec per stored or exchanged format.
 *
 * The writer and the reader of a format import the same codec: there is no
 * second parser to disagree with the first. `renderChecked` renders a value,
 * reads it back with the reader's own `parse`, and throws before anything is
 * written when the two do not agree, so a writer cannot store what its own
 * reader would refuse. Where the format's version is a fact (a store schema),
 * the codec imports it from the store's constant instead of writing it beside it.
 */

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface FormatCodec<T> {
  /** Names the format in a refusal ("push subscription key", "intake email item id"). */
  readonly name: string;
  parse(raw: unknown): ParseResult<T>;
  render(value: T): unknown;
}

/** Declare a format once, for its writer and its reader. */
export function defineFormat<T>(spec: FormatCodec<T>): FormatCodec<T> {
  return Object.freeze({ name: spec.name, parse: spec.parse.bind(spec), render: spec.render.bind(spec) });
}

export class FormatRoundTripError extends Error {
  constructor(readonly format: string, readonly reason: string) {
    super(`${format}: the value was not written, because its own reader would refuse it (${reason}).`);
    this.name = 'FormatRoundTripError';
  }
}

/** Render `value`, read it back with the codec's own parse, and throw before anything is written if they disagree. */
export function renderChecked<T>(codec: FormatCodec<T>, value: T): unknown {
  const rendered = codec.render(value);
  const back = codec.parse(rendered);
  if (!back.ok) throw new FormatRoundTripError(codec.name, back.reason);
  const again = codec.render(back.value);
  if (JSON.stringify(again) !== JSON.stringify(rendered)) throw new FormatRoundTripError(codec.name, 'it reads back as a different value');
  return rendered;
}

/** Parse or throw with the codec's name and reason. */
export function parseOrThrow<T>(codec: FormatCodec<T>, raw: unknown): T {
  const result = codec.parse(raw);
  if (!result.ok) throw new Error(`${codec.name}: ${result.reason}`);
  return result.value;
}
