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
      for (const [index, span] of spans.entries()) {
        const raw = expected[index]!.value.trim().replace(/^["']|["']$/g, '');
        const reference = /^goodvibes:\/\/secrets\/[^\s?#]+$/.test(raw);
        for (const evidence of [false, true]) {
          expect(literalDeclarationValue(text, span, evidence)).toBe(raw.length > 0 && !reference && !(evidence && raw === '[REDACTED]'));
        }
      }
    }
  }
});

test('nested reference spans distinguish separators before their start from separators inside their own path', () => {
  for (const text of ['note=?password=goodvibes://secrets/key', 'password=goodvibes://secrets/a=password=goodvibes://secrets/key', 'password=goodvibes://secrets/key?other=value', 'password=goodvibes://secrets/key#fragment', 'password=goodvibes://secrets/']) {
    for (const span of inlineDeclarations(text, false)) {
      const value = text.slice(span.valueStart, span.valueEnd).replace(/^["']|["']$/g, '');
      expect(literalDeclarationValue(text, span, false)).toBe(value.length > 0 && !/^goodvibes:\/\/secrets\/[^\s?#]+$/.test(value));
    }
  }
});
