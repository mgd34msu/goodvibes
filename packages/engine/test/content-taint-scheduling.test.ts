import { expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { findContentTaint, type TaintSource } from '../sdk/src/platform/security/content-taint.js';
import { MAX_DERIVATION_CHARS } from '../sdk/src/platform/security/batteries/content-derivation.js';
import { securityPort, type DerivationState } from './helpers/security-readings.js';

const sources: readonly TaintSource[] = [
  { surface: 'email', origin: 'first', text: 'Untrusted first source' },
  { surface: 'email', origin: 'second', text: 'Untrusted second source' },
  { surface: 'email', origin: 'third', text: 'Untrusted third source' },
  { surface: 'email', origin: 'fourth', text: 'Untrusted fourth source' },
];

test('a first-source finding dispatches no speculative comparisons for the same field', async () => {
  const fake = securityPort({ derives: () => true });
  const findings = await findContentTaint({ body: 'Owner-composed outward text' }, sources, { port: fake.port });
  expect(findings).toMatchObject([{ field: 'body', origin: 'first', kind: 'derived' }]);
  expect(fake.requests).toHaveLength(1);
});

test('only exact source triples deduplicate; whitespace, surface, origin and embedded separators remain distinct', async () => {
  const first = sources[0]!;
  const unique = [first, { ...first, text: ` ${first.text} ` }, { ...first, surface: 'web-page' },
    { ...first, origin: 'other' }, { ...first, surface: 'a', origin: 'b\0c' }, { ...first, surface: 'a\0b', origin: 'c' }];
  const fake = securityPort({ derives: () => false });
  expect(await findContentTaint({ body: 'Owner-composed outward text' }, [first, { ...first }, ...unique], { port: fake.port })).toEqual([]);
  expect(fake.requests.map(request => (request.state as unknown as DerivationState).source)).toEqual(unique);
});

test('independent fields stay parallel while a field never has overlapping source comparisons', async () => {
  const fake = securityPort({ derives: () => false });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const active = new Set<string>();
  let overlapping = 0, inFlight = 0, peak = 0;
  const port: JudgmentPort = { ...fake.port, async ask(request) {
    const { field } = request.state as unknown as DerivationState;
    if (active.has(field)) overlapping++;
    active.add(field); inFlight++; peak = Math.max(peak, inFlight); calls.push(field);
    if (calls.length === 4) entered();
    try { await gate; return await fake.port.ask(request); }
    finally { active.delete(field); inFlight--; }
  } };
  const work = findContentTaint({ first: 'Owned first', second: 'Owned second', third: 'Owned third', fourth: 'Owned fourth', fifth: 'Owned fifth' }, sources.slice(0, 3), { port });
  try {
    await started;
    expect(calls).toEqual(['first', 'second', 'third', 'fourth']);
    expect(active.size).toBe(4);
  } finally { release(); await work.catch(() => undefined); }
  expect(await work).toEqual([]);
  expect(peak).toBe(4); expect(overlapping).toBe(0); expect(calls).toHaveLength(15);
});

test('deduplication never hides an oversized whitespace variant from full-pass preflight', async () => {
  const fake = securityPort({ derives: () => true });
  const text = 'x'.repeat(MAX_DERIVATION_CHARS);
  await expect(findContentTaint({ body: 'Owned text' }, [
    { surface: 'email', origin: 'same', text },
    { surface: 'email', origin: 'same', text: ` ${text} ` },
  ], { port: fake.port })).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(fake.requests).toHaveLength(0);
});
