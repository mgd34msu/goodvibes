/**
 * Credential-shaped values for fixtures (decision-battery fixtures, proofs and
 * tests), assembled at run time.
 *
 * The repository is public, and a secret scanner reads shape, not intent: a
 * value someone made up to look real is reported, and has to be treated as
 * leaked, exactly like a working one. So no file holds a whole credential
 * shape. A fixture calls one of these instead, and the joined value exists
 * only in memory. `bun run credential-literals:check` fails on a whole shape
 * in any tracked file.
 *
 * Two kinds:
 * - placeholders, in the issuer's shape but plainly not a credential (an
 *   obviously fake id and the marker EXAMPLE), for a fixture that only needs a
 *   value of the right kind;
 * - synthetic values, random-looking characters drawn from a fixed seed, for a
 *   fixture whose point is that the value looks real (a real-or-placeholder
 *   reading, a redaction proof). The same seed gives the same value.
 */

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const ALNUM = `${UPPER}${LOWER}${DIGITS}`;
export const BASE64URL = `${ALNUM}-_`;
export const BASE64 = `${ALNUM}+/`;

/** The marker a placeholder is filled with. */
const MARKER = 'EXAMPLE';
/** The bot id a placeholder Telegram token carries: plainly not an account. */
const PLACEHOLDER_BOT_ID = '123456789';

/** `length` characters of the placeholder marker, repeated. */
function markerRun(length: number): string {
  return MARKER.repeat(Math.ceil(length / MARKER.length)).slice(0, length);
}

/**
 * `length` characters of `alphabet` drawn from `seed`: FNV-1a over the seed,
 * then an xorshift stream. Not random, not secret; the same seed always gives
 * the same characters.
 */
export function syntheticChars(seed: string, length: number, alphabet: string = ALNUM): string {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  let out = '';
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

/** A synthetic credential: `prefix` (an issuer's marker such as `ghp_`) and `length` characters drawn from `seed`. */
export function syntheticCredential(prefix: string, seed: string, length: number, alphabet: string = ALNUM): string {
  return `${prefix}${syntheticChars(`${prefix}${seed}`, length, alphabet)}`;
}

/** A Telegram bot token's shape (bot id, colon, 35 characters) holding a fake id and the EXAMPLE marker. */
export function placeholderTelegramBotToken(): string {
  return [PLACEHOLDER_BOT_ID, `AA${markerRun(33)}`].join(':');
}

/** base64url of UTF-8 text, without padding. */
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A signed JSON web token's shape: an HS256 header, a `sub` claim and a synthetic signature from `seed`. */
export function syntheticJwt(seed: string, subject = 'fixture-user'): string {
  return [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({ sub: subject })),
    syntheticChars(`jwt${seed}`, 43, BASE64URL),
  ].join('.');
}
