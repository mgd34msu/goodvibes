/**
 * secret.ts, a credential as a value whose rule travels with it.
 *
 * A `Secret` holds its text in a private field: nothing reads it structurally,
 * and every way a value is turned into text (`String()`, a template string,
 * `JSON.stringify`, the logger, `console`, `util.inspect`) prints
 * `[secret <label>]`. The text comes out only through `reveal(purpose)`, whose
 * purpose names where it is going: a request to the service the credential is
 * for, the environment of a child it is for, the encrypted store, or a
 * visible "show" the owner asked for. A record holding a `Secret` can be
 * serialized, logged or handed to a model without carrying the value; a sink
 * that needs the text (`bearerHeader`, the store) takes the `Secret` itself.
 *
 * Cost: one small object per secret read; `reveal` is a field read.
 */

/** Why a secret's text is taken out. Each is a dispatch to where the secret belongs. */
export type RevealPurpose =
  /** An HTTP header or body to the service the credential is for. */
  | 'dispatch'
  /** The environment of a child process the credential is for. */
  | 'child-env'
  /** The encrypted secret store. */
  | 'store-write'
  /** An explicit, visible "show" the owner asked for. */
  | 'owner-screen';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  readonly #text: string;
  /** The credential's key or a description of it; never the value. */
  readonly label: string;

  private constructor(text: string, label: string) {
    this.#text = text;
    this.label = label;
    Object.freeze(this);
  }

  /** Wrap `text` as a secret named `label` (the key it is stored under, or what it is). */
  static of(text: string, label: string): Secret {
    return new Secret(text, label);
  }

  /** The text, for the one purpose it is taken out for. */
  reveal(purpose: RevealPurpose): string {
    void purpose;
    return this.#text;
  }

  /** Whether the secret holds no text (an empty value read from a store or typed as nothing). */
  get empty(): boolean {
    return this.#text.length === 0;
  }

  toString(): string {
    return `[secret ${this.label}]`;
  }

  toJSON(): string {
    return `[secret ${this.label}]`;
  }

  [INSPECT](): string {
    return `[secret ${this.label}]`;
  }
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}

/** The one way to build an Authorization header from a secret. */
export function bearerHeader(secret: Secret): { readonly Authorization: string } {
  return { Authorization: `Bearer ${secret.reveal('dispatch')}` };
}
