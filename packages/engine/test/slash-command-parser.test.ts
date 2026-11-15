import { describe, expect, test } from 'bun:test';
import { parseSlashCommand, quoteSlashCommandArg, tokenizeSlashCommand } from '../terminal-shell/src/slash-command-parser.js';

describe('slash command tokenizer', () => {
  test('an empty quoted argument stays an argument', () => {
    expect(tokenizeSlashCommand('a "" b')).toEqual(['a', '', 'b']);
    expect(tokenizeSlashCommand("a ''")).toEqual(['a', '']);
    expect(parseSlashCommand('/x "" a').args).toEqual(['', 'a']);
  });

  test('quoting then parsing returns every argument, empty ones included', () => {
    const args = ['person', 'X Y', '', '--named-by', '', 'say "hi"'];
    const line = `/owner ${args.map(quoteSlashCommandArg).join(' ')}`;
    expect(parseSlashCommand(line).args).toEqual(args);
  });

  test('unquoted whitespace still separates and does not make empty tokens', () => {
    expect(tokenizeSlashCommand('  a   b  ')).toEqual(['a', 'b']);
  });
});
