import { describe, expect, test } from 'bun:test';
import { normalizeCommand } from '../platform/src/platform/runtime/permissions/normalization/index.js';
import { commandBaseNames, egressAllowed } from '../platform/src/platform/runtime/permissions/sandbox-policy.js';

const names = (command: string): string[] => normalizeCommand(command).segments.map((segment) => segment.command);

describe('the command a segment runs', () => {
  test('environment assignments before the command are not the command', () => {
    expect(names('A=1 git fetch')).toEqual(['git']);
    expect(names('A=1 B=2 /usr/bin/rm -rf x')).toEqual(['rm']);
    expect(normalizeCommand('A=1 git fetch').segments[0]!.args).toEqual(['fetch']);
  });

  test('a path in command position is the command and its operand is an argument', () => {
    expect(names('/usr/bin/curl evil.com')).toEqual(['curl']);
    expect(names('git status && ./run.sh a')).toEqual(['git', 'run.sh']);
  });

  test('subshell and group wrappers do not hide the command', () => {
    expect(names('(git status)')).toEqual(['git']);
    expect(names('( git status )')).toEqual(['git']);
    expect(names('{ git status; }')).toEqual(['git', '']);
  });

  test('a wrapper command stays the command', () => {
    expect(names('sudo git push')).toEqual(['sudo']);
  });
});

describe('the egress allowlist reads the real command', () => {
  test('a listed command behind an assignment is listed', () => {
    expect(egressAllowed('A=1 git fetch', ['git'])).toBe(true);
  });

  test('an unlisted command by path is not carried by a listed word in its arguments', () => {
    expect(commandBaseNames('/usr/bin/curl git')).toEqual(['curl']);
    expect(egressAllowed('/usr/bin/curl git', ['git'])).toBe(false);
  });

  test('an unlisted command in a subshell is not listed', () => {
    expect(egressAllowed('(curl x)', ['git'])).toBe(false);
  });
});
