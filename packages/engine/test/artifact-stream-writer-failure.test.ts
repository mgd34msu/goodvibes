import { expect, test } from 'bun:test';
import { chmodSync, statSync, readdirSync, rmSync } from 'node:fs';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('a writer failure after the spool opens rejects, cancels a producer waiting for its next chunk and removes the spool', async () => {
  const root = makeProjectTempDir('artifact-spool-failure');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const store = new ArtifactStore({ rootDir: root });
  let checks = 0;
  try {
    await expect(store.createFromStream({ stream, mimeType: 'image/png', filename: 'test.png', acquisitionMode: 'inline-data', fetchMode: 'not-applicable' }, {
      // Two checks precede the spool, so the third is the first one made inside the writer, when the spool has just
      // opened and the producer has produced nothing. Failing there destroys the writer under a waiting producer.
      assertCurrent() { if (++checks === 3) throw new Error('storage owner changed after open'); },
    })).rejects.toThrow('storage owner changed after open');
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('owner cancellation promptly releases a stalled producer and removes its spool', async () => {
  const root = makeProjectTempDir('artifact-owner-cancel');
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  chmodSync(root, 0o755);
  const store = new ArtifactStore({ rootDir: root });
  try {
    const writing = store.createFromStream({ stream, kind: 'image', filename: 'image.png', mimeType: 'image/png' }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort(new Error('owner cancelled'));
    await expect(writing).rejects.toThrow('owner cancelled');
    expect(cancelled).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    await store.create({ text: 'private content', kind: 'document', filename: 'private.txt' });
    expect(statSync(root).mode & 0o077).toBe(0);
    for (const file of readdirSync(root)) expect(statSync(root + '/' + file).mode & 0o077).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
