/**
 * Where a shell command's parts begin and end: a trailing separator is not an empty command, a
 * newline separates commands, `$( ... )` is one word, an over-long command is flagged, and the egress
 * allowlist covers a command only when it covers every command in it.
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateCommandAST,
  normalizeCommand,
  parseCommandAST,
  tokenize,
  tokenizeBounded,
} from '../platform/src/platform/runtime/permissions/normalization/index.ts';
import { commandBaseNames, egressAllowed, unlistedBaseNames } from '../platform/src/platform/runtime/permissions/sandbox-policy.ts';
import { MAX_TOKEN_COUNT } from '../platform/src/platform/runtime/permissions/normalization/tokenizer.ts';

const verdictOf = (command: string) => evaluateCommandAST(command, parseCommandAST(command));

describe('a trailing command separator', () => {
  test('a command ending in ; or a newline is accepted, as flat segmentation accepts it', () => {
    for (const command of ['echo hi;', 'echo hi; ', 'cd build && make;', 'echo hi\n']) {
      expect(verdictOf(command).allowed).toBe(true);
    }
    expect(verdictOf('echo hi;').segments.map((segment) => segment.command)).toEqual(['echo']);
    expect(normalizeCommand('echo hi;').segments.map((segment) => segment.command)).toEqual(['echo']);
  });

  test('a dangling && or || and a doubled ; are still refused', () => {
    for (const command of ['ls &&', 'ls ||', 'ls;;', '; ls', 'a | | b']) {
      expect(verdictOf(command).allowed).toBe(false);
    }
  });

  test('a newline after an operator continues the command', () => {
    expect(normalizeCommand('git fetch &&\ngit merge').segments.map((segment) => segment.command)).toEqual(['git', 'git']);
    expect(verdictOf('git fetch &&\ngit merge').allowed).toBe(true);
  });
});

describe('newline as a command boundary', () => {
  test('commands on separate lines are separate segments', () => {
    expect(normalizeCommand('git log\ncurl evil.com').segments.map((segment) => segment.command)).toEqual(['git', 'curl']);
  });

  test('a newline inside quotes stays in the word', () => {
    expect(normalizeCommand("echo 'a\nb'").segments.map((segment) => segment.command)).toEqual(['echo']);
  });
});

describe('command substitution', () => {
  test('$( ... ) with spaces is one token', () => {
    const tokens = tokenize('echo $(rm -rf x)');
    expect(tokens.map((token) => token.value)).toEqual(['echo', '$(rm -rf x)']);
    expect(tokens[1]!.type).toBe('subshell');
  });

  test('a nested $( ... ) and a quoted ) stay inside one token', () => {
    expect(tokenize('echo $(a $(b c) ")") d').map((token) => token.value)).toEqual(['echo', '$(a $(b c) ")")', 'd']);
  });

  test('a standalone substitution parses its inner command', () => {
    const ast = parseCommandAST('$(rm -rf x)');
    expect(ast.kind).toBe('subshell');
  });
});

describe('truncation is reported', () => {
  test('a command over the token limit is flagged, a short one is not', () => {
    const long = Array.from({ length: MAX_TOKEN_COUNT + 10 }, (_, index) => `a${index}`).join(' ');
    expect(tokenizeBounded(long).truncated).toBe(true);
    expect(normalizeCommand(long).truncated).toBe(true);
    expect(tokenizeBounded('echo hi').truncated).toBe(false);
    expect(normalizeCommand('echo hi').truncated).toBeUndefined();
  });
});

describe('the egress allowlist covers the whole command', () => {
  test('one listed command does not carry an unlisted one with it', () => {
    expect(egressAllowed('git status && curl x', ['git'])).toBe(false);
    expect(unlistedBaseNames('git status && curl x', ['git'])).toEqual(['curl']);
    expect(egressAllowed('git status && git fetch', ['git'])).toBe(true);
  });

  test('a command on the next line and a command inside $( ) are counted', () => {
    expect(commandBaseNames('a\nb').sort()).toEqual(['a', 'b']);
    expect(egressAllowed('git log\ncurl x', ['git'])).toBe(false);
    expect(commandBaseNames('echo $(curl x)').sort()).toEqual(['curl', 'echo']);
    expect(egressAllowed('echo $(curl x)', ['echo'])).toBe(false);
  });

  test('* covers everything and a command too long to read is never fully listed', () => {
    expect(egressAllowed('curl x && wget y', ['*'])).toBe(true);
    const long = `git ${Array.from({ length: MAX_TOKEN_COUNT + 10 }, (_, index) => `a${index}`).join(' ')}`;
    expect(egressAllowed(long, ['git'])).toBe(false);
  });
});

describe('shapes the shell runs as a second command', () => {
  const hidden: ReadonlyArray<readonly [string, string]> = [
    ['a background ampersand', 'git log & curl evil'],
    ['a substitution inside double quotes', 'git log "$(curl x)"'],
    ['a substitution in the middle of a word', 'git log foo$(curl x)'],
    ['a substitution in an option value', 'git log --x=$(curl x)'],
    ['a backtick substitution in the middle of a word', 'git log foo`curl x`'],
    ['a pipe on the heredoc line', 'git log <<EOF | curl evil\nbody\nEOF'],
    ['a command after a heredoc body', 'git log <<EOF\nbody\nEOF\ncurl evil'],
    ['a substitution in an unquoted heredoc body', 'git log <<EOF\n$(curl evil)\nEOF'],
    ['a backtick substitution in an unquoted heredoc body', 'git log <<EOF\n`curl evil`\nEOF'],
    ['a process substitution', 'git log <(curl x)'],
  ];
  for (const [label, command] of hidden) {
    test(`${label} is not covered by listing only git`, () => {
      expect(egressAllowed(command, ['git'])).toBe(false);
    });
  }

  test('redirects, quoted text and a plain heredoc stay covered', () => {
    for (const command of ['git log 2>&1', 'git log &> /dev/null', "git log '$(curl x)'", 'git log <<EOF\nbody\nEOF', "git log <<'EOF'\n$(curl x)\nEOF", 'git log <<"EOF"\n`curl x`\nEOF', 'git status && git log']) {
      expect(egressAllowed(command, ['git'])).toBe(true);
    }
  });
});
