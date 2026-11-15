import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { knowledgeUriRef } from '../platform/src/platform/knowledge/uri-canonicalization/battery.js';
import { registry } from '../platform/src/platform/knowledge/uri-canonicalization/judgment-registry.js';
import { createKnowledgeUriCanonicalizer, KnowledgeUriCanonicalizationHeldError as Held } from '../platform/src/platform/knowledge/uri-canonicalization/reader.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [], stores: KnowledgeStore[] = [], releases: (() => void)[] = [], pending: Promise<unknown>[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  installJudgmentPort(previous);
  await Promise.allSettled(pending.splice(0));
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const contentOne = 'https://docs.example.test/document?ref=document-one';
const contentTwo = 'https://docs.example.test/document?ref=document-two';
const referral = 'https://shop.example.test/item?ref=affiliate-alice';
function answers(probability: number) { const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port); return fake; }
async function held(work: Promise<unknown>, reason: Held['reason']) {
  const error: unknown = await work.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Held);
  if (!(error instanceof Held)) throw new Error('Expected a canonical URI hold');
  expect(error.reason).toBe(reason);
}
describe('Knowledge concrete ref identity', () => {
  test('registered versioned yes/no reading preserves original confidence floor and contrasted fixture expectations', async () => {
    expect(registry.list().map(battery => battery.name)).toEqual(['engine.knowledge.uri-ref']);
    expect(knowledgeUriRef.version).toBe(1); expect(knowledgeUriRef.accuracyFloor).toBeGreaterThanOrEqual(0.95);
    const fake = fakePort((name, _question, state) => {
      const fixture = knowledgeUriRef.fixtures.find(item => JSON.stringify(item.state) === JSON.stringify(state));
      if (name !== 'referral' || !fixture) throw new Error('Unscripted URI fixture');
      return noulAnswer(fixture.expect.referral === 'yes' ? 0.99 : 0.01);
    });
    const results = await knowledgeUriRef.checkFixtures(fake.port);
    expect(results).toHaveLength(10); expect(results.every(result => result.correct && result.outcome === 'act')).toBe(true);
  });
  test('settled referral ref merges with the clean address; settled page ref preserves distinct content', async () => {
    const yes = answers(0.99), tracking = createKnowledgeUriCanonicalizer();
    expect(await tracking.canonicalize(referral)).toBe('https://shop.example.test/item');
    expect(await tracking.canonicalize('https://shop.example.test/item')).toBe('https://shop.example.test/item');
    expect(yes.requests).toHaveLength(1);
    const no = answers(0.01), content = createKnowledgeUriCanonicalizer();
    expect(await content.canonicalizeAll([contentOne, contentTwo])).toEqual([contentOne, contentTwo]);
    expect(no.requests).toHaveLength(2);
  });
  test('unchanged structural and defined tracking conventions need no judgment port', async () => {
    const reader = createKnowledgeUriCanonicalizer();
    expect(await reader.canonicalize('HTTPS://DOCS.EXAMPLE.TEST:443/path///?z=2&utm_campaign=x&fbclid=y&gclid=z&a=1#section'))
      .toBe('https://docs.example.test/path?a=1&z=2');
    expect(await reader.canonicalize('https://docs.example.test/?Ref=release')).toBe('https://docs.example.test/?Ref=release');
    expect(await reader.canonicalize('not a URI')).toBeNull();
    const nativeReferences = Array.from({ length: 1000 }, (_, index) => `https://docs.example.test/native/${index}`);
    expect(await reader.canonicalizeAll(nativeReferences)).toEqual(nativeReferences);
  });
  test('each repeated ref occurrence is decided separately and content multiplicity survives stable sorting', async () => {
    const uri = 'https://docs.example.test/page?z=last&ref=document-one&ref=affiliate-alice&ref=document-one&a=first';
    const fake = fakePort((_name, _question, state) => noulAnswer(state && typeof state === 'object' && !Array.isArray(state) && state.target && typeof state.target === 'object'
      && !Array.isArray(state.target) && state.target.position === 2 ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    expect(await createKnowledgeUriCanonicalizer().canonicalize(uri))
      .toBe('https://docs.example.test/page?a=first&ref=document-one&ref=document-one&z=last');
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map(request => { const state = request.state; return state && typeof state === 'object' && !Array.isArray(state) ? state.target : undefined; })).toEqual([
      { position: 1, key: 'ref', value: 'document-one' }, { position: 2, key: 'ref', value: 'affiliate-alice' }, { position: 3, key: 'ref', value: 'document-one' },
    ]);
  });
  test('an uncertain, unavailable or unconfigured ref holds and cannot acquire a keep-or-strip fallback', async () => {
    await held(createKnowledgeUriCanonicalizer().canonicalize(contentOne), 'unconfigured');
    answers(0.5); const unknown = createKnowledgeUriCanonicalizer();
    await held(unknown.canonicalize(contentOne), 'uncertain'); expect(() => unknown.assertCurrent()).toThrow(Held);
    const fake = answers(0.01); installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic outage'); } });
    await held(createKnowledgeUriCanonicalizer().canonicalize(contentOne), 'unavailable');
  });
  test('a complete ref-bearing batch and percent-decoded credential fields are screened before earlier safe wires, caps or cache reuse', async () => {
    for (const inputs of [
      [contentOne, 'https://docs.example.test/page?ref=document&password=never-transmit'],
      [contentOne, 'https://docs.example.test/page?ref=password%3Dnever-transmit'],
      [...Array.from({ length: 1001 }, (_, index) => `https://docs.example.test/page?ref=document-${index}`), 'https://docs.example.test/page?ref=document&password=never-transmit'],
    ]) {
      const fake = answers(0.01);
      await expect(createKnowledgeUriCanonicalizer().canonicalizeAll(inputs)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
    const fake = answers(0.01), reader = createKnowledgeUriCanonicalizer();
    await reader.canonicalize(contentOne);
    await expect(reader.canonicalizeAll([contentOne, 'https://docs.example.test/page?ref=document&password=never-transmit'])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(1);
  });
  test('the complete provider response cannot hide credentials behind a settled probability or an unused field', async () => {
    const fake = answers(0.01);
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), extra: { password: 'never-transmit' } }; } });
    await expect(createKnowledgeUriCanonicalizer().canonicalize(contentOne)).rejects.toBeInstanceOf(JudgmentInputError);
  });
  test('input mutation during a pending reading retires the entire batch before cache publication', async () => {
    const fake = answers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
    installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
    const inputs = [contentOne], reader = createKnowledgeUriCanonicalizer(), work = reader.canonicalizeAll(inputs); pending.push(work);
    await entered.promise; inputs[0] = contentTwo; release.resolve(); await held(work, 'stale');
    expect(() => reader.assertCurrent()).toThrow(Held);
  });
  test('installation ABA, method mutation, removal, source retirement and caller retirement revoke settled identity reuse', async () => {
    for (const mode of ['aba', 'method', 'remove', 'source', 'caller'] as const) {
      const fake = answers(0.01), identity = {}, source = new AbortController(); let current = true;
      bindJudgmentPortAuthority(fake.port, () => ({ identity, signal: source.signal, assertCurrent: () => {} }));
      const reader = createKnowledgeUriCanonicalizer({ assertCurrent() { if (!current) throw new Error('retired'); } });
      await reader.canonicalize(contentOne);
      if (mode === 'aba') { installJudgmentPort({ ...fake.port }); installJudgmentPort(fake.port); }
      if (mode === 'method') Object.assign(fake.port, { ask: fakePort(() => noulAnswer(0.99)).port.ask });
      if (mode === 'remove') installJudgmentPort(undefined);
      if (mode === 'source') source.abort();
      if (mode === 'caller') current = false;
      await held(reader.canonicalize(contentOne), 'stale');
    }
  });
  test('abort and timeout interrupt an owned noncooperative wire, preserve its failed run and drain late settlement', async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      const fake = answers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
      installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
      const controller = new AbortController(), reader = createKnowledgeUriCanonicalizer({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 10 : 1000 });
      const work = reader.canonicalize(contentOne); pending.push(work); await entered.promise;
      if (mode === 'abort') controller.abort();
      await held(work, mode === 'abort' ? 'aborted' : 'budget');
      release.resolve(); await Promise.resolve(); expect(() => reader.assertCurrent()).toThrow(Held);
    }
  });
  test('a synchronous caller returning a promise or replacing its own option cannot authorize a wire', async () => {
    for (const result of ['promise', 'replace'] as const) {
      const fake = answers(0.01), options = { assertCurrent() {
        if (result === 'promise') return Promise.resolve();
        options.assertCurrent = () => undefined;
        return undefined;
      } };
      expect(() => createKnowledgeUriCanonicalizer(options)).toThrow(Held); expect(fake.requests).toHaveLength(0);
    }
  });
});
