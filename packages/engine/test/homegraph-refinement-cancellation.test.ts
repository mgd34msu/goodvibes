import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHomeGraphRefinement } from '../platform/src/platform/knowledge/home-graph/refinement.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-refinement-cancellation-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const semantic = new KnowledgeSemanticService(store);
  return { root, store, semantic };
}

function expectAbort(error: unknown): void {
  expect(error).toBeInstanceOf(DOMException);
  if (!(error instanceof DOMException)) throw new Error('Refinement did not report owner cancellation');
  expect(error.name).toBe('AbortError');
}

test('a cancelled refinement owner never initializes its store or enters semantic work', async () => {
  const { root, store, semantic } = fixture();
  const init = spyOn(store, 'init');
  const improve = spyOn(semantic, 'selfImprove');
  const owner = new AbortController();
  owner.abort();
  try {
    const error = await runHomeGraphRefinement({ store, semanticService: semantic, signal: owner.signal })
      .then(() => 'completed', (failure: unknown) => failure);
    expectAbort(error);
    expect(init).not.toHaveBeenCalled();
    expect(improve).not.toHaveBeenCalled();
  } finally {
    init.mockRestore(); improve.mockRestore();
    await semantic.dispose(); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refinement passes its original signal to real semantic work and drains that work before rejecting cancellation', async () => {
  const { root, store, semantic } = fixture();
  const owner = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const initialize = store.init.bind(store), selfImprove = semantic.selfImprove.bind(semantic);
  let calls = 0, settled = false, semanticCompleted = false;
  let semanticSignal: AbortSignal | undefined;
  const init = spyOn(store, 'init').mockImplementation(async () => {
    // The second initialization belongs to the actual semantic service, after
    // the refinement leaf has admitted it. Hold the original call, not a race.
    if (++calls === 2) { entered.resolve(); await release.promise; }
    await initialize();
  });
  const improve = spyOn(semantic, 'selfImprove').mockImplementation(async (input, options) => {
    semanticSignal = input?.signal;
    const result = await selfImprove(input, options);
    semanticCompleted = true;
    return result;
  });
  const outcome = runHomeGraphRefinement({ store, semanticService: semantic, installationId: 'cancelled-refinement', signal: owner.signal })
    .then(() => { settled = true; return 'completed'; }, (error: unknown) => { settled = true; return error; });
  try {
    await entered.promise;
    expect(semanticSignal).toBe(owner.signal);
    owner.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(semanticSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(semanticCompleted).toBe(false);
    release.resolve();
    expectAbort(await outcome);
    expect(semanticCompleted).toBe(true);
    expect(improve).toHaveBeenCalledTimes(1);
    expect(store.listNodes()).toEqual([]);
    expect(store.listIssues()).toEqual([]);
    expect(store.listRefinementTasks()).toEqual([]);
  } finally {
    release.resolve(); await outcome;
    init.mockRestore(); improve.mockRestore();
    await semantic.dispose(); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const skipGapRefinement of [false, true]) {
  test(`cancellation during real triage initialization prevents ${skipGapRefinement ? 'a triage-only success' : 'later semantic refinement'}`, async () => {
    const { root, store, semantic } = fixture();
    const owner = new AbortController();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const initialize = store.init.bind(store);
    let calls = 0, settled = false;
    const init = spyOn(store, 'init').mockImplementation(async () => {
      if (++calls === 2) { entered.resolve(); await release.promise; }
      await initialize();
    });
    const improve = spyOn(semantic, 'selfImprove');
    const outcome = runHomeGraphRefinement({ store, semanticService: semantic, installationId: 'cancelled-triage',
      signal: owner.signal, triage: true, skipGapRefinement })
      .then(() => { settled = true; return 'completed'; }, (error: unknown) => { settled = true; return error; });
    try {
      await entered.promise;
      owner.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      expectAbort(await outcome);
      expect(improve).not.toHaveBeenCalled();
      expect(store.listNodes()).toEqual([]);
      expect(store.listIssues()).toEqual([]);
      expect(store.listRefinementTasks()).toEqual([]);
    } finally {
      release.resolve(); await outcome;
      init.mockRestore(); improve.mockRestore();
      await semantic.dispose(); await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
