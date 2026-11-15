import { describe, expect, test } from 'bun:test';
import { handleRecallSearch } from '../../input/commands/recall-query.ts';
import { handleRecallAdd } from '../../input/commands/recall-capture.ts';
import { handleRecallQueue } from '../../input/commands/recall-review.ts';
import { handleRecallExport } from '../../input/commands/recall-bundle.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('/memory search', () => {
  test('reads the memory spine the model\'s tools write through when the runtime wired it', async () => {
    const printed: string[] = [];
    let spineSearches = 0;
    let localSearches = 0;
    const ctx = {
      print: (text: string) => { printed.push(text); },
      clients: {
        memorySpine: { list: async () => { spineSearches += 1; return []; }, searchSemantic: async () => [], get: async () => null, linksFor: async () => [], link: async () => null, delete: async () => false },
        agentKnowledgeApi: { memory: { search: () => { localSearches += 1; return []; } } },
      },
    } as unknown as CommandContext;
    await handleRecallSearch(['anything'], ctx);
    expect(spineSearches).toBe(1);
    expect(localSearches).toBe(0);
  });
});

describe('/memory writes and reviews', () => {
  const record = { id: 'mem-1', scope: 'project', cls: 'fact', summary: 'kept', tags: [], provenance: [], reviewState: 'fresh', confidence: 80 };
  function wired() {
    const root = makeProjectTempDir('gv-recall-spine');
    const printed: string[] = [];
    const calls = { spineAdd: 0, localAdd: 0, spineQueue: 0, localQueue: 0, spineExport: 0, localExport: 0 };
    const ctx = {
      print: (text: string) => { printed.push(text); },
      session: { runtime: { sessionId: 's1' } },
      workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
      clients: {
        memorySpine: {
          add: async () => { calls.spineAdd += 1; return record; },
          reviewQueue: async () => { calls.spineQueue += 1; return []; },
          exportBundle: async () => { calls.spineExport += 1; return { recordCount: 0, linkCount: 0, records: [], links: [] }; },
        },
        agentKnowledgeApi: {
          memory: {
            add: async () => { calls.localAdd += 1; return record; },
            reviewQueue: async () => { calls.localQueue += 1; return []; },
            exportBundle: () => { calls.localExport += 1; return { recordCount: 0, linkCount: 0, records: [], links: [] }; },
          },
        },
      },
    } as unknown as CommandContext;
    return { ctx, calls, printed };
  }

  test('add writes to the spine, so a later search through the spine finds the record', async () => {
    const { ctx, calls } = wired();
    await handleRecallAdd(['fact', 'kept'], ctx);
    expect(calls.spineAdd).toBe(1);
    expect(calls.localAdd).toBe(0);
  });

  test('the review queue reads the spine', async () => {
    const { ctx, calls } = wired();
    await handleRecallQueue([], ctx);
    expect(calls.spineQueue).toBe(1);
    expect(calls.localQueue).toBe(0);
  });

  test('export reads the spine', async () => {
    const { ctx, calls } = wired();
    await handleRecallExport(['bundle.json', '--yes'], ctx);
    expect(calls.spineExport).toBe(1);
    expect(calls.localExport).toBe(0);
  });

  test('without a spine the embedded local registry is used', async () => {
    const { ctx, calls } = wired();
    (ctx.clients as unknown as { memorySpine?: unknown }).memorySpine = undefined;
    await handleRecallAdd(['fact', 'kept'], ctx);
    expect(calls.localAdd).toBe(1);
  });
});
