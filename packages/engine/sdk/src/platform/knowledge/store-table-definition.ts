/** Compare only our fixed native table definitions. SQLite ALTER TABLE retains
 * its older layout whitespace; fresh and migrated rows have the same SQL tokens.
 * Literal/default bytes are never normalized. Comments remain distinct tokens. */
export function sameNativeKnowledgeTableSql(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  return compact(actual) === compact(expected.trim().replace('IF NOT EXISTS ', ''));
}
function compact(sql: string): string {
  let result = '', pendingSpace = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (/\s/.test(char)) { pendingSpace = true; continue; }
    if (pendingSpace && result.length > 0 && !',()'.includes(char) && !',('.includes(result.at(-1)!)) result += ' ';
    pendingSpace = false;
    result += char;
    if (char !== "'" && char !== '"' && char !== '`' && char !== '[') continue;
    const closing = char === '[' ? ']' : char;
    for (++index; index < sql.length; index++) {
      const literal = sql[index]!; result += literal;
      if (literal !== closing) continue;
      if (sql[index + 1] === closing && closing !== ']') { result += closing; index += 1; continue; }
      break;
    }
  }
  return result;
}
