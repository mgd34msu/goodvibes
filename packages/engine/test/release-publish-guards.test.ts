import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertStagesAtRootVersion, cleanupAuthEnv, createAuthEnv } from '../scripts/release-shared.ts';

describe('publish guards', () => {
  test('a public package at another version stops the release before anything is published, naming both versions', () => {
    const stages = [
      { dir: '../judgment', manifest: { name: '@goodvibes-jev/judgment', version: '3.2.0' } },
      { dir: '.', manifest: { name: '@goodvibes-jev/engine', version: '3.3.0' } },
    ];
    expect(() => assertStagesAtRootVersion(stages, '3.3.0')).toThrow(/@goodvibes-jev\/judgment is at 3\.2\.0.*3\.3\.0|3\.3\.0.*@goodvibes-jev\/judgment is at 3\.2\.0/);
    expect(() => assertStagesAtRootVersion(stages.slice(1), '3.3.0')).not.toThrow();
  });

  test('the temporary npmrc that holds the publish token is readable by its owner only', () => {
    const auth = createAuthEnv({ NODE_AUTH_TOKEN: 'token-for-test' }, { registry: 'https://registry.npmjs.org' });
    try {
      expect(statSync(resolve(auth.tempDir!, '.npmrc')).mode & 0o777).toBe(0o600);
    } finally { cleanupAuthEnv(auth); }
  });
});
