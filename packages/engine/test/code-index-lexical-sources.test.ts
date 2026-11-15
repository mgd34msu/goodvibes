/**
 * Lexical code search reads each recalled file once, never judges text that no
 * longer matches the chunk it was indexed as, and does not read oversized files.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { CodeIndexStore } from '../platform/src/platform/state/code-index-store.js';
import { MemoryEmbeddingProviderRegistry, embedMemoryText, type MemoryEmbeddingProvider } from '../platform/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';

type PairState = { readonly candidate: { readonly symbol?: string; readonly path: string; readonly code?: string } };

function provider(id: string): MemoryEmbeddingProvider {
  const embed = (text: string, dimensions: number) => ({ vector: embedMemoryText(text, dimensions), dimensions });
  return { id, label: id, dimensions: 384, deterministic: true, embedSync: r => embed(r.text, r.dimensions), embed: async r => embed(r.text, r.dimensions) };
}

let root: string;
let store: CodeIndexStore;
let previous: ReturnType<typeof installJudgmentPort>;

async function build(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'gv-code-lexical-src-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, '.config') }) });
  registry.register(provider('prov-x'), { makeDefault: true });
  store = new CodeIndexStore(root, ':memory:', registry);
  await store.init();
  await store.buildFull();
  registry.register(provider('prov-y'), { makeDefault: true });
}

beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.9)).port); });
afterEach(() => { installJudgmentPort(previous); store.close(); rmSync(root, { recursive: true, force: true }); });

function recordingPort() {
  const states: PairState[] = [];
  const port = fakePort((_name: string, _question, state: EntryType) => { states.push(state as unknown as PairState); return noulAnswer(0.9); });
  installJudgmentPort(port.port);
  return states;
}

test('a chunk whose file was edited since indexing is judged without the text now at its old lines', async () => {
  await build({ 'retry.ts': 'export function retryWithBackoff(): void {}\n' });
  const states = recordingPort();
  writeFileSync(join(root, 'retry.ts'), '// header added\n// another line\nexport const unrelated = 1;\n');
  utimesSync(join(root, 'retry.ts'), new Date(), new Date(Date.now() + 5_000));
  await store.search('retryWithBackoff', { limit: 5 });
  const state = states.find(entry => entry.candidate.symbol === 'retryWithBackoff')!;
  expect(state.candidate.code).toBeUndefined();
});

test('an unchanged file is still judged with its code', async () => {
  await build({ 'retry.ts': 'export function retryWithBackoff(): void {}\n' });
  const states = recordingPort();
  await store.search('retryWithBackoff', { limit: 5 });
  expect(states.find(entry => entry.candidate.symbol === 'retryWithBackoff')!.candidate.code).toContain('retryWithBackoff');
});

test('each recalled file is read once however many ranking attempts check it', async () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`retry${n}.ts`, `export function retryWorker${n}(): void {}\n`]));
  await build(files);
  recordingPort();
  const reads = spyOn(nativeFs, 'readSync');
  try { await store.search('retry', { limit: 10 }); }
  finally { reads.mockRestore(); }
  // One data read plus the end-of-file probe per file; re-reading for every attempt would multiply this.
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2 * 12);
});

test('a file above the size cap is not read and is judged on its path and symbol', async () => {
  await build({ 'retry.ts': `export function retryWithBackoff(): void {}\n${'// padding\n'.repeat(120_000)}` });
  const states = recordingPort();
  const reads = spyOn(nativeFs, 'readSync');
  try { await store.search('retryWithBackoff', { limit: 5 }); }
  finally { reads.mockRestore(); }
  expect(states.find(entry => entry.candidate.symbol === 'retryWithBackoff')!.candidate.code).toBeUndefined();
  expect(reads.mock.calls.length).toBe(0);
});
