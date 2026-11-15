import { describe, expect, test } from 'bun:test';
import { canonicalize, isEnvAssignmentToken } from '../platform/src/platform/runtime/permissions/normalization/canonicalizer.ts';

describe('canonicalize', () => {
  test('a quoted path containing a space names its last path element', () => {
    expect(canonicalize('"/my dir/rm"')).toBe('rm');
    expect(canonicalize("'/my dir/RM'")).toBe('rm');
  });

  test('a backslash-escaped name resolves to the name the shell runs', () => {
    expect(canonicalize('\\rm')).toBe('rm');
    expect(canonicalize('/my\\ dir/rm')).toBe('rm');
  });

  test('leading environment assignments in an unquoted line are skipped', () => {
    expect(canonicalize('FOO=bar git')).toBe('git');
    expect(canonicalize('/usr/bin/git')).toBe('git');
  });

  test('a quoted assignment is a command word, not an assignment', () => {
    expect(canonicalize('"FOO=bar git"')).toBe('foo=bar git');
  });

  test('env assignment tokens are recognised for callers that pick the command word', () => {
    expect(isEnvAssignmentToken('GIT_SSH_COMMAND=x')).toBe(true);
    expect(isEnvAssignmentToken('git')).toBe(false);
  });
});
