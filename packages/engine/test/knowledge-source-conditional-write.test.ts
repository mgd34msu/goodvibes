import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '@goodvibes-jev/engine/platform/platform/knowledge';

// A conditional source write against an expected-absent row: exactly one of
// several store handles (or processes) on one file may create it, and the loser
// changes nothing on disk.
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function owned(store: KnowledgeStore): KnowledgeStore { stores.push(store); return store; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-conditional-write-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const first = owned(new KnowledgeStore({ dbPath: path }));
  const second = owned(new KnowledgeStore({ dbPath: path }));
  return { path, first, second };
}
async function reopen(path: string) {
  const store = owned(new KnowledgeStore({ dbPath: path })); await store.init();
  return { store };
}

test('two independently loaded handles cannot both create an absent conditional source', async () => {
  const f = fixture();
  await f.first.init(); await f.second.init();
  const source = { id: 'conditional', connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const };
  const results = await Promise.all([
    f.first.upsertSourceIfCurrent({ ...source, metadata: { owner: 'first' } }, null),
    f.second.upsertSourceIfCurrent({ ...source, metadata: { owner: 'second' } }, null),
  ]);
  const third = await reopen(f.path);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  const winner = results[0]!.kind === 'written' ? 'first' : 'second';
  expect(third.store.getSource(source.id)?.metadata.owner).toBe(winner);
});

test('an absent-row condition observes a creation through another initialized real handle', async () => {
  const { path: file, first, second } = fixture();
  await first.init(); await second.init();
  const input = { id: 'shared-row', connectorId: 'fixture', sourceType: 'dataset' as const, status: 'indexed' as const, metadata: { value: 'first' } };
  expect((await first.upsertSourceIfCurrent(input, null)).kind).toBe('written');
  const before = readFileSync(file);
  const result = await second.upsertSourceIfCurrent({ ...input, metadata: { value: 'second' } }, null);
  expect(result.kind).toBe('held');
  expect(readFileSync(file)).toEqual(before);
});

test('separate processes released from one barrier cannot both win an expected-null creation', async () => {
  const f = fixture();
  const script = `
    import { KnowledgeStore } from '@goodvibes-jev/engine/platform/platform/knowledge';
    const store = new KnowledgeStore({ dbPath: process.argv[1] });
    await store.init();
    console.log('ready');
    await Bun.stdin.text();
    const result = await store.upsertSourceIfCurrent({ id: 'process-conditional', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { owner: process.argv[2] } }, null);
    console.log(JSON.stringify({ owner: process.argv[2], kind: result.kind }));
  `;
  const children = ['first', 'second'].map(owner => Bun.spawn([
    process.execPath, '--no-env-file', '--preload', new URL('../toolchain/src/test-runner/test-network-preload.ts', import.meta.url).pathname,
    '-e', script, f.path, owner,
  ], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  const readers = children.map(child => child.stdout.getReader());
  try {
    await Promise.all(readers.map(async reader => {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('ready');
    }));
    for (const child of children) { child.stdin.write('go'); child.stdin.end(); }
    const results = await Promise.all(children.map(async (child, index) => {
      const output = async () => { let text = ''; for (;;) { const chunk = await readers[index]!.read(); if (chunk.done) return text; text += new TextDecoder().decode(chunk.value); } };
      const [exit, text, error] = await Promise.all([child.exited, output(), new Response(child.stderr).text()]);
      expect({ exit, error }).toEqual({ exit: 0, error: '' });
      return JSON.parse(text.trim()) as { owner: string; kind: 'written' | 'held' };
    }));
    const third = await reopen(f.path);
    expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
    expect(third.store.getSource('process-conditional')?.metadata.owner).toBe(results.find(result => result.kind === 'written')!.owner);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map(child => child.exited));
    for (const reader of readers) reader.releaseLock();
  }
});
