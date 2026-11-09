import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { suiteReleaseFixture } from '@goodvibes-jev/engine/toolchain/testing/suite-release';

test('complete original daemon and SQLite fixture pins are computed once before independent update verification', () => {
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
  } finally {
    for (const restore of restores) restore(); hash.mockRestore(); fixture?.cleanup();
  }
});
