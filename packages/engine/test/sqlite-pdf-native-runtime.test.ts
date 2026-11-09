import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { extractPdf } from '../platform/src/platform/knowledge/pdf-extractor.js';
import { inspectPersistedPlanningProjects } from '../platform/src/platform/knowledge/project-planning/persisted-projects.js';
import { loadSqlJsEngine } from '../platform/src/platform/state/sqlite-store.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(.99)).port); });
afterEach(async () => { installJudgmentPort(previous); await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-pdf-runtime-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  await store.upsertSource({ id: 'saved-project-state', connectorId: 'goodvibes-project-planning', sourceType: 'dataset',
    title: 'Saved planning state', status: 'indexed', metadata: { projectId: 'saved-project',
      knowledgeSpaceId: 'project:saved-project', planningArtifactKind: 'state', planningArtifactId: 'current' } });
  return { store, path };
}

test('actual SQLite initialization then lazy PDF extraction preserves genuine read-only project inspection', async () => {
  const f = await fixture(), bytes = readFileSync(f.path);
  const extraction = await extractPdf(createCompressedPdfBuffer('This controlled manual describes four local ports.'));
  expect(extraction.excerpt).toContain('four local ports');
  const view = await inspectPersistedPlanningProjects(f.path, () => {});
  expect(view.projectIds).toEqual(['saved-project']); view.assertCurrent();
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('an unrelated function-source inspector is never invoked by native persisted scalar reads', async () => {
  const f = await fixture(), bytes = readFileSync(f.path);
  const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
  if (!descriptor) throw new Error('Original function inspector descriptor missing');
  let called = 0;
  Object.defineProperty(Function.prototype, 'toString', { ...descriptor, value() { called++; throw new Error('Unrelated function inspection'); } });
  let ids: readonly string[] | undefined;
  try { const view = await inspectPersistedPlanningProjects(f.path, () => {}); ids = view.projectIds; view.assertCurrent(); }
  finally { Object.defineProperty(Function.prototype, 'toString', descriptor); }
  expect(called).toBe(0); expect(ids).toEqual(['saved-project']); expect(readFileSync(f.path)).toEqual(bytes);
});

test.each(['decode', 'subarray', 'driver'] as const)('the actual %s dependency remains guarded before borrowed code sees an image', async kind => {
  const f = await fixture(), bytes = readFileSync(f.path), engine = await loadSqlJsEngine();
  const target = kind === 'decode' ? TextDecoder.prototype : kind === 'subarray' ? Uint8Array.prototype : engine.Database.prototype;
  const key = kind === 'driver' ? 'exec' : kind;
  const descriptor = Object.getOwnPropertyDescriptor(target, key); let called = 0;
  Object.defineProperty(target, key, { ...(descriptor ?? { configurable: true, writable: true }),
    value() { called++; throw new Error('Borrowed native decoder'); } });
  let rejected = false;
  try { await inspectPersistedPlanningProjects(f.path, () => {}); }
  catch { rejected = true; }
  finally { if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key); }
  expect(rejected).toBe(true); expect(called).toBe(0); expect(readFileSync(f.path)).toEqual(bytes);
});
