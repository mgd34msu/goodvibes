/**
 * Whether a failed `npm view` means the package or version is absent from the
 * registry (scripts/verify-published-packages.ts): decided by the JSON error
 * code npm prints, never by wording.
 */
import { describe, expect, test } from 'bun:test';

import {
  isMissingPublishedVersionError,
  npmViewErrorCode,
  parseNpmViewString,
} from '../scripts/verify-published-packages.ts';

function commandError(message: string, output: { stderr?: string; stdout?: string; code?: string } = {}): Error {
  return Object.assign(new Error(message), output);
}

describe('npm view --json error codes', () => {
  function viewError(stdout: string): Error {
    return commandError('Command failed: npm view', { stdout });
  }

  test('an absent package or version is code E404 in the JSON error, never read from wording', () => {
    const absentVersion = viewError(JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 9.9.9' } }));
    const absentTarget = viewError(JSON.stringify({ error: { code: 'ETARGET', summary: 'No matching version' } }));
    expect(npmViewErrorCode(absentVersion)).toBe('E404');
    expect(isMissingPublishedVersionError(absentVersion)).toBe(true);
    expect(isMissingPublishedVersionError(absentTarget)).toBe(true);
  });

  test('any other failure is not treated as absent', () => {
    expect(isMissingPublishedVersionError(viewError(JSON.stringify({ error: { code: 'E500', summary: 'Internal Server Error' } })))).toBe(false);
    expect(isMissingPublishedVersionError(viewError('is not in this registry'))).toBe(false);
    expect(isMissingPublishedVersionError(commandError('Command failed: npm view'))).toBe(false);
  });

  test('parses the JSON value npm view prints', () => {
    expect(parseNpmViewString('"2.0.23"\n')).toBe('2.0.23');
    expect(parseNpmViewString('')).toBeNull();
    expect(parseNpmViewString('["2.0.22","2.0.23"]')).toBe('2.0.23');
  });
});
