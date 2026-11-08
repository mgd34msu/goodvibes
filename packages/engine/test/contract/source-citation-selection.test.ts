import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { selectSourceCitationEvidence } from '../../sdk/src/platform/contract/source-citation-selection.js';
import type { UnitEvidence } from '../../sdk/src/platform/contract/evidence.js';

function largeEvidence(output: string): UnitEvidence {
  return { output, changedPaths: [], diff: '', omitted: [], commands: [], sourceReads: [
    { path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000, contentKind: 'cited-source',
      returnedContent: Array.from({ length: 5000 }, (_, i) => `${i + 1} | const value${i} = decodeURIComponent(input);`).join('\n') },
    { path: 'input.json', returnedRanges: ['1-2'], returnedLines: 2, contentKind: 'declared-reference', returnedContent: '1 | {\n2 | }' },
  ] };
}

test('receipt quotations are removed without losing full scope, input, report, raw evidence or real finding citations', async () => {
  const evidence = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely. Finding: src/parser.ts:42-44 has an unchecked decode.');
  const raw = JSON.stringify(evidence), owner = {};
  const { port, requests } = fakePort((name, _, state) => noulAnswer((state as { citations: { start: number }[] }).citations[Number(name.split('_').at(-1))]!.start === 1 ? 0.99 : 0.01));
  const selected = await selectSourceCitationEvidence(owner, evidence, port);
  expect(selected.evidence.output).toBe(evidence.output);
  expect(selected.evidence.sourceReads![0]).toMatchObject({ returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(selected.evidence.sourceReads![0]!.returnedContent!.split('\n').map(row => row.split(' | ')[0])).toEqual(['42', '43', '44']);
  expect(selected.evidence.sourceReads![1]).toEqual(evidence.sourceReads![1]);
  expect(JSON.stringify(evidence)).toBe(raw);
  expect(selected.usage.calls).toBe(1);
  await selectSourceCitationEvidence(owner, evidence, port);
  expect(requests).toHaveLength(1);
});

test.each([0.5, 0.01])('uncertain or substantive citation contexts retain every source byte (%s)', async probability => {
  const evidence = largeEvidence('src/parser.ts:1-5000 was read and contains an unchecked decode.');
  const { port } = fakePort(() => noulAnswer(probability));
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence).toBe(evidence);
});

test('a receipt-only report keeps all observed ranges while reducing its check payload', async () => {
  const evidence = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely.');
  const { port } = fakePort(() => noulAnswer(0.99));
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence.sourceReads![0]).toEqual({ path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(JSON.stringify(selected.evidence).length).toBeLessThan(1000);
});

test('small evidence requires no extra judgment', async () => {
  const evidence: UnitEvidence = { output: 'Reviewed the helper.', changedPaths: [], diff: '', omitted: [], commands: [] };
  const { port, requests } = fakePort(() => { throw new Error('no call expected'); });
  expect((await selectSourceCitationEvidence({}, evidence, port)).evidence).toBe(evidence);
  expect(requests).toEqual([]);
});

test('old primary quotations are not retransmitted after the report removes its old citations', async () => {
  const evidence = largeEvidence('The revised read ledger lists paths and intervals in separate fields; no old source citations remain.');
  const { port, requests } = fakePort(() => { throw new Error('no current citations to classify'); });
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence.sourceReads![0]).toEqual({ path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(selected.evidence.sourceReads![1]).toEqual(evidence.sourceReads![1]);
  expect(requests).toEqual([]);
  expect(evidence.sourceReads![0]!.returnedContent!.length).toBeGreaterThan(100000);
});

test('the cache belongs to the complete current report and the actual owner', async () => {
  const owner = {}, first = largeEvidence('Read src/parser.ts:1-5000 completely.');
  const changed = largeEvidence(first.output + ' A later qualification changes the complete report.');
  const { port, requests } = fakePort(() => noulAnswer(0.99));
  await selectSourceCitationEvidence(owner, first, port);
  await selectSourceCitationEvidence(owner, first, port); expect(requests).toHaveLength(1);
  await selectSourceCitationEvidence(owner, changed, port); expect(requests).toHaveLength(2);
  await selectSourceCitationEvidence(owner, first, port); expect(requests).toHaveLength(3);
  await selectSourceCitationEvidence({}, first, port); expect(requests).toHaveLength(4);
});

test('a late result for another report cannot overwrite the current report cache', async () => {
  const owner = {}, old = largeEvidence('OLD read ledger: src/parser.ts:1-5000.'), current = largeEvidence('CURRENT finding: src/parser.ts:1-5000.');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fake = fakePort((_name, _question, state) => noulAnswer((state as { report: string }).report === old.output ? 0.99 : 0.01));
  const port = { ...fake.port, async ask(request: Parameters<typeof fake.port.ask>[0]) {
    if ((request.state as { report: string }).report === old.output) { entered(); await hold; }
    return fake.port.ask(request);
  } } as typeof fake.port;
  const pending = selectSourceCitationEvidence(owner, old, port); await ready;
  expect((await selectSourceCitationEvidence(owner, current, port)).evidence).toBe(current);
  release(); await pending;
  expect((await selectSourceCitationEvidence(owner, current, port)).evidence).toBe(current);
  expect(fake.requests).toHaveLength(2);
});

test('repeated read records classify each actual report occurrence once while retaining every scope record', async () => {
  const original = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely.');
  const evidence = { ...original, sourceReads: [...original.sourceReads!, { ...original.sourceReads![0]! }] };
  const { port, requests } = fakePort(() => noulAnswer(0.99));
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(Object.keys(requests[0]!.questions)).toEqual(['citation_0']);
  expect(selected.evidence.sourceReads).toHaveLength(3);
  expect(selected.evidence.sourceReads![0]).toEqual(selected.evidence.sourceReads![2]);
  expect(selected.evidence.sourceReads![0]?.returnedRanges).toEqual(['1-5000']);
});

for (const changed of ['report', 'returned-content', 'returned-ranges'] as const) test(`changed ${changed} cannot publish a selection from the prior captured evidence`, async () => {
  const evidence = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely.');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fake = fakePort(() => noulAnswer(0.99));
  const port = { ...fake.port, async ask(request: Parameters<typeof fake.port.ask>[0]) {
    entered(); await hold; return fake.port.ask(request);
  } } as typeof fake.port;
  const pending = selectSourceCitationEvidence({}, evidence, port); await ready;
  if (changed === 'report') Object.assign(evidence, { output: 'This source is substantive evidence of a finding.' });
  else if (changed === 'returned-content') Object.assign(evidence.sourceReads![0]!, { returnedContent: '1 | Changed source content' });
  else Object.assign(evidence.sourceReads![0]!, { returnedRanges: ['1'] });
  release(); await expect(pending).rejects.toThrow();
});
