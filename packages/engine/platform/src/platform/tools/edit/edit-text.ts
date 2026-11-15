/**
 * The one rule for which text an edit entry will match and write.
 *
 * The edit tool, the approval broker and the surfaces that show an edit for
 * approval all read an entry through `resolveEditText`, so the text an owner
 * approves is the text the tool writes. This module imports nothing at run
 * time, so a browser bundle can use it as it is.
 */
import type { EditItem } from './types.js';

const BASE64_VALUES: ReadonlyMap<string, number> = new Map([
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((char, index) => [char, index] as const),
  ['-', 62], ['_', 63],
]);

/** Base64 (standard or URL alphabet, padding optional, whitespace ignored) to UTF-8 text. */
export function decodeBase64(value: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    if (char === '=') break;
    const digit = BASE64_VALUES.get(char);
    if (digit === undefined) continue;
    buffer = ((buffer << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The fields of an edit entry this rule reads; every other field is ignored. */
export type EditTextFields = Pick<EditItem, 'find_base64' | 'replace_base64'> & {
  readonly find?: string | undefined;
  readonly replace?: string | undefined;
};

/**
 * The find and replace text the executor will use. The base64 field wins when
 * set; a plain field that disagrees with it is refused, so the text an owner
 * is shown for approval cannot differ from the bytes written.
 */
export function resolveEditText(item: EditTextFields): { find: string; replace: string } | { error: string } {
  const plainFind = item.find ?? '';
  const find = item.find_base64 ? decodeBase64(item.find_base64) : plainFind;
  if (item.find_base64 && plainFind !== '' && plainFind !== find) {
    return { error: 'find and find_base64 disagree. Send only one of them.' };
  }
  if (find === '') {
    return { error: 'The find text is empty. Send the text to match in find or find_base64.' };
  }
  if (item.replace === undefined && item.replace_base64 === undefined) {
    return { error: 'The replacement is missing. Send replace or replace_base64 (an empty string deletes the match).' };
  }
  const plainReplace = item.replace ?? '';
  const replace = item.replace_base64 !== undefined ? decodeBase64(item.replace_base64) : plainReplace;
  if (item.replace_base64 !== undefined && plainReplace !== '' && plainReplace !== replace) {
    return { error: 'replace and replace_base64 disagree. Send only one of them.' };
  }
  return { find, replace };
}
