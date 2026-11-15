import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishDaemonSqliteCompanion } from '../../../scripts/build-sqlite-runtime.ts';
import type { DaemonSqliteOwner } from '../../cli/native-sqlite-runtime.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const metadata = { schema: 1, packageName: '@goodvibes-jev/daemon' } as unknown as DaemonSqliteOwner;

test('leftovers of an interrupted run neither block the next run nor survive it', () => {
  const root = makeOwnedTempDir('daemon-sqlite-publish');
  const output = join(root, 'lib', 'libsqlite3.dylib'); const provenance = output + '.json';
  mkdirSync(join(root, 'lib'));
  // An interrupted producer: stale temporary names plus an older, now-mismatched library.
  writeFileSync(output + '.building', 'stale'); writeFileSync(provenance + '.building', 'stale'); writeFileSync(output, 'old library');
  publishDaemonSqliteCompanion(output, provenance, Buffer.from('new library'), metadata);
  expect(readFileSync(output, 'utf8')).toBe('new library');
  expect(JSON.parse(readFileSync(provenance, 'utf8'))).toEqual({ schema: 1, packageName: '@goodvibes-jev/daemon' });
  expect(existsSync(output + '.building')).toBe(false);
  expect(existsSync(provenance + '.building')).toBe(false);
});
