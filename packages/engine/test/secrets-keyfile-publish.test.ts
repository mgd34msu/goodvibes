import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const real = { ...realFs };
const writes: string[] = [];
const links: Array<{ from: string; to: string }> = [];
let beforeLink: (() => void) | null = null;

mock.module('fs', () => ({
  ...real,
  writeFileSync: (path: string, ...rest: unknown[]) => {
    writes.push(String(path));
    return (real.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
  },
  linkSync: (from: string, to: string) => {
    links.push({ from: String(from), to: String(to) });
    beforeLink?.();
    return real.linkSync(from, to);
  },
}));

const { loadOrCreateKeyfile } = await import('../platform/src/platform/config/secrets-keyfile.js');

const roots: string[] = [];
afterAll(() => {
  mock.module('fs', () => real);
  for (const root of roots) real.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { writes.length = 0; links.length = 0; beforeLink = null; });

function keyfilePath(): string {
  const root = makeProjectTempDir('secrets-keyfile-publish');
  roots.push(root);
  return join(root, 'home', '.goodvibes', 'secrets.key');
}

describe('keyfile creation', () => {
  test('writes only a temporary file and links it into place, never opening the keyfile for write', () => {
    const path = keyfilePath();
    const key = loadOrCreateKeyfile(path);
    expect(writes.length).toBe(1);
    expect(writes[0]).not.toBe(path);
    expect(writes[0]!.startsWith(`${path}.`) && writes[0]!.endsWith('.tmp')).toBe(true);
    expect(links).toEqual([{ from: writes[0]!, to: path }]);
    expect(real.readFileSync(path, 'utf8').trim()).toBe(key.toString('hex'));
  });

  test('a link onto a keyfile another process just created leaves it untouched and adopts its key', () => {
    const path = keyfilePath();
    const winner = 'ab'.repeat(32);
    beforeLink = () => real.writeFileSync(path, `${winner}\n`, { mode: 0o600 });
    const key = loadOrCreateKeyfile(path);
    expect(key.toString('hex')).toBe(winner);
    expect(real.readFileSync(path, 'utf8')).toBe(`${winner}\n`);
    expect(writes.filter((p) => p === path)).toEqual([]);
    expect(real.readdirSync(join(path, '..')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
