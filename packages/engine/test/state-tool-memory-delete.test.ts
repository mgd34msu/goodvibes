/**
 * A memory key lives in a flat file and in a retrievable record. The state tool
 * can remove both together, says when the record is gone or when an earlier
 * version is still being retrieved, and never reports a key it cannot delete.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateTool } from '../platform/src/platform/tools/state/index.ts';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.ts';
import { memoryReadingsPort } from './_helpers/memory-readings.ts';
import { toolReadingsPort } from './_helpers/tool-readings.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';

function statePort(): JudgmentPort {
  const classPort = toolReadingsPort([]).port;
  const memory = memoryReadingsPort().port;
  return { model: memory.model, ask: (request) => ('memory_class' in request.questions ? classPort.ask(request) : memory.ask(request)) };
}

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(statePort()); });
const roots: string[] = [];
afterEach(() => { installJudgmentPort(previousPort); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-memory-delete-')); roots.push(root);
  const memoryDir = join(root, '.goodvibes', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
    enableVectorIndex: false,
  });
  await store.init();
  const registry = new MemoryRegistry(store);
  const tool = createStateTool(new KVState({ stateDir: join(root, 'state') }), new ProjectIndex(root), { memoryDir, memoryRegistry: registry });
  const tagged = (key: string) => registry.getAll().filter((record) => record.tags.includes(`state-memory:${key}`));
  const out = (result: { output?: string | undefined }) => JSON.parse(result.output ?? '{}') as Record<string, unknown>;
  return { tool, registry, memoryDir, tagged, out };
}

describe('state mode=memory delete', () => {
  test('removes the flat file and its retrieval record together', async () => {
    const h = await harness();
    await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    expect(h.tagged('style')).toHaveLength(1);
    const deleted = await h.tool.execute({ mode: 'memory', memoryAction: 'delete', memoryKey: 'style' });
    expect(deleted.success).toBe(true);
    expect(h.out(deleted)).toMatchObject({ file_deleted: true, records_deleted: 1 });
    expect(existsSync(join(h.memoryDir, 'style.json'))).toBe(false);
    expect(h.tagged('style')).toHaveLength(0);
  });

  test('a key that does not exist is reported, not claimed as deleted', async () => {
    const h = await harness();
    const result = await h.tool.execute({ mode: 'memory', memoryAction: 'delete', memoryKey: 'nothing' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('memoryAction=list');
  });

  test('a new value that is not indexed says that the earlier version stays retrievable', async () => {
    const h = await harness();
    await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    const second = await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'apiKey=synthetic-private-secret' });
    expect(second.success).toBe(true);
    expect(h.out(second)).toMatchObject({ retrievable: false });
    expect(String(h.out(second).note)).toContain('earlier version');
    expect(h.tagged('style')[0]!.detail).toBe('The user prefers tabs.');
  });

  test('get says when the retrieval record is gone, so the agent knows the text no longer reaches prompts', async () => {
    const h = await harness();
    await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    expect(h.out(await h.tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'style' })).retrievable).toBe(true);
    for (const record of h.tagged('style')) h.registry.delete(record.id);
    expect(h.out(await h.tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'style' })).retrievable).toBe(false);
  });
  test('get says when the retrieved text was corrected through recall and no longer matches the file', async () => {
    const h = await harness();
    await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    for (const record of h.tagged('style')) h.registry.update(record.id, { detail: 'The user prefers spaces.' });
    const got = h.out(await h.tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'style' }));
    expect(got.retrieved_text_differs).toBe(true);
    expect(String(got.note)).toContain('differs');
  });

  test('get stays quiet when the retrieved text matches the file', async () => {
    const h = await harness();
    await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    expect(h.out(await h.tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'style' })).retrieved_text_differs).toBeUndefined();
  });

  test('over the wire, delete removes the file and says the host record is not removed', async () => {
    const h = await harness();
    const wired = createStateTool(new KVState({ stateDir: join(h.memoryDir, '..', 'state2') }), new ProjectIndex(join(h.memoryDir, '..')), { memoryDir: h.memoryDir, memoryRegistry: h.registry, memoryRoutedOverWire: () => true });
    await wired.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'style', memoryValue: 'The user prefers tabs.' });
    const deleted = await wired.execute({ mode: 'memory', memoryAction: 'delete', memoryKey: 'style' });
    expect(deleted.success).toBe(true);
    expect(h.out(deleted)).toMatchObject({ file_deleted: true, records_deleted: 0 });
    expect(String(h.out(deleted).note)).toContain('not removed');
  });
});
