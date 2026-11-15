import { describe, expect, test } from 'bun:test';
import { renderCompletion } from '../../cli/completion.ts';
import { renderGoodVibesHelp } from '../../cli/help.ts';

/** Command words as `goodvibes help` advertises them, aliases included. */
function advertisedCommands(): string[] {
  const lines = renderGoodVibesHelp('goodvibes').split('\n');
  const start = lines.indexOf('Commands:');
  const end = lines.indexOf('Options:');
  const words: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = /^ {2}([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?: |$)/u.exec(line);
    if (match) words.push(...match[1]!.split('|'));
  }
  return words;
}

describe('the completion script a user installs', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    test(`${shell} offers every advertised command and none that was removed`, () => {
      const script = renderCompletion(shell);
      for (const word of advertisedCommands()) expect(script).toMatch(new RegExp(`(^|[^a-z-])${word}([^a-z-]|$)`, 'u'));
      expect(script).not.toMatch(/(^|[^a-z-])serve([^a-z-]|$)/u);
    });
  }

  test('it offers the run limits and the commands that were missing', () => {
    const script = renderCompletion('bash');
    for (const word of ['hooks', 'plugin', 'host', '--timeout', '--max-turns', '--non-interactive']) expect(script).toContain(word);
  });

  test('an unknown shell gets the bash script', () => {
    expect(renderCompletion('tcsh')).toBe(renderCompletion('bash'));
  });
});
