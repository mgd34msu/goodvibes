/**
 * Fenced code blocks that hold arbitrary text (a model's answer, a document),
 * written and read by one rule: the writer picks a fence longer than any
 * backtick run in the text, and the reader closes a block only on a fence of
 * the same character at least as long as the one that opened it.
 */

/** `value` inside a backtick fence it cannot end early. */
export function fencedBlock(value: string, info = ''): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${value}\n${fence}`;
}

interface OpenFence { readonly char: '`' | '~'; readonly length: number }

/**
 * Line-by-line fence state for a Markdown reader. `step(line)` returns whether
 * the line is part of a fenced block (its opening and closing fences included).
 */
export function createFenceTracker(): { step(line: string): boolean } {
  let open: OpenFence | null = null;
  return {
    step(line: string): boolean {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open) {
        if (match && match[1]![0] === open.char && match[1]!.length >= open.length && match[2]!.trim() === '') open = null;
        return true;
      }
      if (!match) return false;
      const char = match[1]![0] as '`' | '~';
      // A backtick fence's info string cannot itself contain a backtick.
      if (char === '`' && match[2]!.includes('`')) return false;
      open = { char, length: match[1]!.length };
      return true;
    },
  };
}
