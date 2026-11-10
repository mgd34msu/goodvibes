/** Real vector-cache/native file adapters with only model answers and read policy synthetic. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createCanonicalLiveCodeSource } from './_helpers/code-injection-readings.ts';

const syntheticRelevance = () => fakePort(() => noulAnswer(0.99));

test('unchanged original code can rank and revalidate repeatedly with no SHA execution', async () => {
  const live = await createCanonicalLiveCodeSource(), fixture = syntheticRelevance(), previous = installJudgmentPort(fixture.port);
  const hashes = spyOn(crypto, 'createHash');
  try {
    const hits = await live.store.search('backoff'); expect(hits.length).toBeGreaterThan(0);
    expect(JSON.parse(hits[0]!.chunk.fileRevision)[0]).toBe('code-file-observation-v1');
    const reading = await live.store.rankForInjection('backoff', hits, { readAccessFilter: live.readAccessFilter });
    expect(reading.ranked.length).toBeGreaterThan(0);
    await reading.assertCurrent(); await reading.assertCurrent();
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests.every(request => request.context?.site === 'state.code-injection-relevance')).toBe(true);
    expect(hashes).not.toHaveBeenCalled();
  } finally { hashes.mockRestore(); installJudgmentPort(previous); live.dispose(); }
});

for (const change of ['same-size', 'restored', 'replacement'] as const) test(`a ${change} file is stale before any relevance request`, async () => {
  const live = await createCanonicalLiveCodeSource(), fixture = syntheticRelevance(), previous = installJudgmentPort(fixture.port);
  try {
    const hits = await live.store.search('backoff'), before = statSync(live.path);
    const original = 'export async function backoff() { await sleep(base * 2 ** attempt); }\n';
    if (change === 'replacement') { writeFileSync(live.path + '.replacement', original); renameSync(live.path + '.replacement', live.path); }
    else {
      writeFileSync(live.path, original.replace('backoff', 'changed'));
      if (change === 'restored') writeFileSync(live.path, original);
      utimesSync(live.path, before.atime, before.mtime);
    }
    await expect(live.store.rankForInjection('backoff', hits, { readAccessFilter: live.readAccessFilter })).rejects.toThrow('Code injection source is stale');
    expect(fixture.requests).toHaveLength(0);
  } finally { installJudgmentPort(previous); live.dispose(); }
});

test('changed source during a relevance await is refused before result release', async () => {
  const live = await createCanonicalLiveCodeSource(), fixture = syntheticRelevance();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const previous = installJudgmentPort({ ...fixture.port, async ask(request) { entered.resolve(); await release.promise; return fixture.port.ask(request); } });
  let pending: ReturnType<typeof live.store.rankForInjection> | undefined;
  try {
    const hits = await live.store.search('backoff');
    pending = live.store.rankForInjection('backoff', hits, { readAccessFilter: live.readAccessFilter });
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Ranking settled before the held source boundary'); })]);
    live.mutate(); release.resolve();
    await expect(pending).rejects.toThrow();
  } finally { release.resolve(); await pending?.catch(() => undefined); installJudgmentPort(previous); live.dispose(); }
});

test('read-authority retirement and cancellation remain binding even for an unchanged original revision', async () => {
  const live = await createCanonicalLiveCodeSource(), fixture = syntheticRelevance(), previous = installJudgmentPort(fixture.port);
  try {
    const hits = await live.store.search('backoff');
    const reading = await live.store.rankForInjection('backoff', hits, { readAccessFilter: live.readAccessFilter });
    live.deny(); await expect(reading.assertCurrent()).rejects.toThrow('access-restricted');
    const canceled = new AbortController(); canceled.abort(new Error('Original owner canceled'));
    await expect(live.store.rankForInjection('backoff', hits, { readAccessFilter: live.readAccessFilter, signal: canceled.signal })).rejects.toThrow('Original owner canceled');
  } finally { installJudgmentPort(previous); live.dispose(); }
});
