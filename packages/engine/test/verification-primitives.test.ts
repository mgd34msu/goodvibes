import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createVerificationPrimitives,
  readVerificationHostToken,
  resolveVerificationHostUrl,
} from '../terminal-shell/src/verification-primitives.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const primitives = createVerificationPrimitives({
  compact: (text) => text.trim(),
  error: (error) => (error instanceof Error ? error.message : String(error)),
  missingBearer: 'no token',
  validateJsonOnNonZero: true,
});

describe('runCommand', () => {
  test('captures all output of a command that writes a lot and exits', async () => {
    const dir = makeProjectTempDir('verification-run');
    const result = await primitives.runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(1_000_000))"], dir, 20_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(1_000_000);
  });

  test('bounds what it keeps from a command that writes far more', async () => {
    const dir = makeProjectTempDir('verification-run');
    const result = await primitives.runCommand(process.execPath, ['-e', "process.stdout.write('y'.repeat(20_000_000))"], dir, 20_000);
    expect(result.stdout.length).toBeLessThan(20_000_000);
    expect(result.stdout.length).toBeGreaterThan(1_000_000);
  });

  test('resolves with what was captured when a grandchild keeps the pipes open after the child exits', async () => {
    const dir = makeProjectTempDir('verification-run');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });",
      'g.unref();',
      "process.stdout.write('done');",
    ].join('\n');
    const started = Date.now();
    const result = await primitives.runCommand(process.execPath, ['-e', script], dir, 20_000);
    // Waiting for the grandchild to close the pipes would take ~30s.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
    expect(result.timedOut).toBe(false);
  });
});

describe('host discovery', () => {
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

  test('the port comes from the settings file the caller names, not the terminal product\'s', () => {
    const home = makeProjectTempDir('verification-home');
    mkdirSync(join(home, 'agent'), { recursive: true });
    writeFileSync(join(home, 'agent', 'settings.json'), JSON.stringify({ controlPlane: { port: 4555 } }));
    expect(resolveVerificationHostUrl(home, undefined, [], readJson, join(home, 'agent', 'settings.json'))).toBe('http://127.0.0.1:4555');
    expect(resolveVerificationHostUrl(home, undefined, [], readJson)).toBe('http://127.0.0.1:3421');
  });

  test('the bearer token is read from the path the caller names', () => {
    const home = makeProjectTempDir('verification-home');
    writeFileSync(join(home, 'tokens.json'), JSON.stringify({ token: 'from-custom-path' }));
    expect(readVerificationHostToken(home, [], readJson, join(home, 'tokens.json'))).toBe('from-custom-path');
    expect(readVerificationHostToken(home, [], readJson)).toBeUndefined();
  });
});
