import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { suiteReleaseFixture } from '@goodvibes-jev/engine/toolchain/testing/suite-release';

test('complete original daemon and SQLite fixture pins are computed once through release manifest fetches', async () => {
  const create = crypto.createHash, reads: Array<() => readonly unknown[]> = [], restores: Array<() => void> = [];
  const hash = spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
    const hasher = create(algorithm, options);
    if (algorithm === 'sha256') {
      const update = spyOn(hasher, 'update'); reads.push(() => update.mock.calls.map(([input]) => input));
      restores.push(() => update.mockRestore());
    }
    return hasher;
  });
  let fixture: ReturnType<typeof suiteReleaseFixture> | undefined;
  try {
    fixture = suiteReleaseFixture();
    const firstManifest = await (await fixture.fetchImpl('https://fixture.invalid/SHA256SUMS.txt')).text();
    const inputs = reads.flatMap(read => read());
    for (const original of [
      fixture.original.get(join(fixture.root, 'goodvibes-daemon')),
      fixture.release.get('goodvibes-daemon-macos-x64'),
      fixture.original.get(join(fixture.root, 'lib/sqlite-darwin-x64/libsqlite3.dylib')),
      fixture.release.get('sqlite-darwin-x64.dylib'),
    ]) {
      expect(original).toBeDefined();
      expect(inputs.filter(input => input === original)).toHaveLength(1);
    }
    const initialHashes = reads.length;
    expect(await (await fixture.fetchImpl('https://fixture.invalid/SHA256SUMS.txt')).text()).toBe(firstManifest);
    expect(reads).toHaveLength(initialHashes);
    const deleted = 'sqlite-darwin-x64.dylib.json';
    fixture.release.delete(deleted);
    expect(await (await fixture.fetchImpl('https://fixture.invalid/SHA256SUMS.txt')).text()).not.toContain(`  ${deleted}\n`);
    expect(reads).toHaveLength(initialHashes);
    const name = 'goodvibes-daemon-macos-x64', bytes = fixture.release.get(name);
    if (!bytes) throw new Error('Missing original daemon bytes');
    const originalDaemonLine = firstManifest.split('\n').find(line => line.endsWith(`  ${name}`));
    if (!originalDaemonLine) throw new Error('Missing original daemon manifest pin');
    bytes[0] = bytes[0]! ^ 1;
    const changedManifest = await (await fixture.fetchImpl('https://fixture.invalid/SHA256SUMS.txt')).text();
    expect(changedManifest).not.toContain(originalDaemonLine);
    expect(reads).toHaveLength(initialHashes + 1);
    fixture.release.set(name, Buffer.from(bytes));
    expect(await (await fixture.fetchImpl('https://fixture.invalid/SHA256SUMS.txt')).text()).toBe(changedManifest);
    expect(reads).toHaveLength(initialHashes + 2);
  } finally {
    for (const restore of restores) restore(); hash.mockRestore(); fixture?.cleanup();
  }
});
