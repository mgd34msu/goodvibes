import { expect, test } from 'bun:test';
import { inlineDeclarations, literalDeclarationValue } from '../platform/src/platform/gate/inline-declarations.js';

/** Frozen pre-change grammar: compatibility oracle for small syntax cases only. */
function originalDeclarations(text: string, flags: boolean): { key: string; value: string }[] {
  const pattern = flags
    ? /(?:^|[\s{[,;&?="'])--?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|\s)\s*(?=([^\s,;}]+))/g
    : /(?:^|[\s{[,;&?="'])([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(?=([^\s,;}]+))/g;
  const declarations: { key: string; value: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    pattern.lastIndex = match.index + 1;
    declarations.push({ key: match[1]!, value: match[2]! });
  }
  return declarations;
}

test('span scanning preserves the prior flag and field declaration grammar, including overlapping and empty values', () => {
  const prefixes = ['', 'note: ', 'outer=', '"outer": "', '?', '/', 'x', '{[', '\uFEFF', '--'];
  const declarations = ['password', '--password', '-password', '---password', 'ordinary.key', '_key'];
  const separators = ['=', ':', ' ', ' = ', ' : ', '" : ', "'\t=\r\n", '\u2028', '\t\t='];
  const values = ['', 'literal', '=', ',next', ';next', '}next', "''", "'", 'password=value', '--password value', 'goodvibes://secrets/key', '"goodvibes://secrets/key"', 'goodvibes://secrets/key?query', '[REDACTED]'];
  for (const prefix of prefixes) for (const declaration of declarations) for (const separator of separators) for (const value of values) {
    const text = prefix + declaration + separator + value;
    for (const flags of [true, false]) {
      const spans = [...inlineDeclarations(text, flags)];
      const expected = originalDeclarations(text, flags);
      expect(spans.map(span => ({ key: span.key, value: text.slice(span.valueStart, span.valueEnd) }))).toEqual(expected);
    }
  }
});

/**
 * Explicit cases rather than a restatement of the rule: each row is one declaration the scanner finds,
 * and whether its value is a literal (a real inline secret) or a secret-store reference, with and
 * without evidence that the text was already redacted.
 */
const LITERAL_CASES: readonly { text: string; flags: boolean; key: string; value: string; literal: boolean; literalWhenRedactedEvidence?: boolean }[] = [
  { text: 'password=hunter2', flags: false, key: 'password', value: 'hunter2', literal: true },
  { text: 'password="hunter2"', flags: false, key: 'password', value: '"hunter2"', literal: true },
  { text: '--password hunter2', flags: true, key: 'password', value: 'hunter2', literal: true },
  { text: 'password=goodvibes://secrets/key', flags: false, key: 'password', value: 'goodvibes://secrets/key', literal: false },
  { text: 'password="goodvibes://secrets/key"', flags: false, key: 'password', value: '"goodvibes://secrets/key"', literal: false },
  { text: 'note=?password=goodvibes://secrets/key', flags: false, key: 'password', value: 'goodvibes://secrets/key', literal: false },
  { text: 'password=goodvibes://secrets/a=password=goodvibes://secrets/key', flags: false, key: 'password', value: 'goodvibes://secrets/a=password=goodvibes://secrets/key', literal: false },
  // A reference followed by a query or fragment is not a bare reference: the tail is unknown text.
  { text: 'password=goodvibes://secrets/key?other=value', flags: false, key: 'password', value: 'goodvibes://secrets/key?other=value', literal: true },
  { text: 'password=goodvibes://secrets/key#fragment', flags: false, key: 'password', value: 'goodvibes://secrets/key#fragment', literal: true },
  // No key name after the scheme path: nothing is being referenced.
  { text: 'password=goodvibes://secrets/', flags: false, key: 'password', value: 'goodvibes://secrets/', literal: true },
  { text: "password=''", flags: false, key: 'password', value: "''", literal: false },
  { text: 'password=[REDACTED]', flags: false, key: 'password', value: '[REDACTED]', literal: true, literalWhenRedactedEvidence: false },
];

test('literalDeclarationValue separates real inline values from references and empty values', () => {
  for (const row of LITERAL_CASES) {
    const span = [...inlineDeclarations(row.text, row.flags)].find(candidate => candidate.key === row.key && row.text.slice(candidate.valueStart, candidate.valueEnd) === row.value);
    expect(span, row.text).toBeDefined();
    expect(literalDeclarationValue(row.text, span!, false), row.text).toBe(row.literal);
    expect(literalDeclarationValue(row.text, span!, true), `${row.text} with redaction evidence`).toBe(row.literalWhenRedactedEvidence ?? row.literal);
  }
});
