/** Regression source authored during coding; execution deferred. */
import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { assertKnowledgeRestriction, createKnowledgeExtractionOwner } from '../platform/src/platform/knowledge/extraction-ownership.js';
import { KnowledgeExtractionJudgmentHoldError, readKnowledgeExtractionTextUsability } from '../platform/src/platform/knowledge/extraction-policy.js';
import { KnowledgeEntityAliasHoldError } from '../platform/src/platform/knowledge/entity-aliases.js';
import { KnowledgeSourceQualityHeldError, isKnowledgeSourceQualityFailure } from '../platform/src/platform/knowledge/source-quality.js';
import { HomeGraphPagePriorityHeldError } from '../platform/src/platform/knowledge/home-graph/page-priority.js';
import { HomeGraphQualityHeldError } from '../platform/src/platform/knowledge/home-graph/quality/types.js';
import { KnowledgeUriCanonicalizationHeldError } from '../platform/src/platform/knowledge/uri-canonicalization/types.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../platform/src/platform/knowledge/semantic/verification/types.js';
import { KnowledgeFactReadSetStaleError } from '../platform/src/platform/knowledge/semantic/fact-quality.js';
import { KnowledgeRepairFactUsefulnessHeldError } from '../platform/src/platform/knowledge/semantic/repair-usefulness/types.js';

const previous = installJudgmentPort(undefined);
afterEach(() => { installJudgmentPort(previous); });
const text = 'The reference manual describes the original device controls.';

test('local restriction failures preserve their typed finite refusal without retaining private error payloads', () => {
  for (const original of [new KnowledgeEntityAliasHoldError(), new KnowledgeSourceQualityHeldError('stale'),
    new HomeGraphPagePriorityHeldError('aborted'), new HomeGraphQualityHeldError('stale'),
    new KnowledgeUriCanonicalizationHeldError('aborted'), new KnowledgeGeneratedFactSupportHeldError('stale'),
    new KnowledgeRepairFactUsefulnessHeldError('not-useful'), new KnowledgeFactReadSetStaleError('local-fact-label')]) {
    original.message = 'PRIVATE_RESTRICTION_DETAIL';
    Object.defineProperty(original, 'privateBody', { value: 'PRIVATE_RESTRICTION_DETAIL', enumerable: true });
    let failure: unknown;
    try { assertKnowledgeRestriction(() => { throw original; }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected a typed restriction refusal');
    expect(failure.constructor).toBe(original.constructor);
    expect(failure).not.toBe(original);
    expect(Object.getOwnPropertyDescriptor(failure, 'reason')?.value).toBe(Object.getOwnPropertyDescriptor(original, 'reason')?.value);
    expect(failure.message).not.toContain('PRIVATE_RESTRICTION_DETAIL');
    expect(Object.hasOwn(failure, 'privateBody')).toBe(false);
    if (original instanceof KnowledgeFactReadSetStaleError) expect(Object.getOwnPropertyDescriptor(failure, 'factId')?.value).toBe(original.factId);
    if (original instanceof KnowledgeRepairFactUsefulnessHeldError) expect(isKnowledgeSourceQualityFailure(failure)).toBe(true);
    const owner = createKnowledgeExtractionOwner({ assertCurrent() { throw original; } });
    expect(() => owner.assertCurrent()).toThrow(failure);
  }
});

test('copied private fact getters cannot supply the local retry selector and generic holds cannot be swallowed as non-quality failures', () => {
  let reads = 0;
  const borrowed = new KnowledgeFactReadSetStaleError('original');
  Object.defineProperty(borrowed, 'factId', { get() { reads++; throw new Error('PRIVATE_FACT_SELECTOR'); } });
  for (const original of [borrowed, new KnowledgeFactReadSetStaleError(''), new Error('PRIVATE_OWNER_FAILURE')]) {
    let failure: unknown;
    try { assertKnowledgeRestriction(() => { throw original; }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(isKnowledgeSourceQualityFailure(failure)).toBe(true);
    expect(String(failure)).not.toContain('PRIVATE_');
  }
  expect(reads).toBe(0);
});

test('unknown private errors and borrowed reason accessors remain value-free extraction holds', () => {
  let reads = 0;
  const local = new KnowledgeSourceQualityHeldError('stale');
  Object.defineProperty(local, 'reason', { get() { reads++; return 'stale'; } });
  for (const original of [new Error('PRIVATE_RESTRICTION_DETAIL'), local,
    new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE_RESTRICTION_DETAIL'); } })]) {
    let failure: unknown;
    try { assertKnowledgeRestriction(() => { throw original; }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(String(failure)).not.toContain('PRIVATE_RESTRICTION_DETAIL');
  }
  expect(reads).toBe(0);
});

for (const kind of ['value', 'promise', 'thrown-promise'] as const) {
  test(`the actual extraction reader holds a caller restriction returning ${kind} before transmitting content`, async () => {
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const owner = createKnowledgeExtractionOwner({ assertCurrent: () => {
      if (kind === 'value') return true;
      const failure = Promise.reject(new Error('Private caller restriction detail'));
      if (kind === 'thrown-promise') throw failure;
      return failure;
    } });
    await expect(readKnowledgeExtractionTextUsability(text, undefined, owner)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(fake.requests).toHaveLength(0);
    // A rejected restriction is observed even though it cannot be accepted.
    await Promise.resolve(); await Promise.resolve();
  });
}

for (const retained of [false, true]) {
  test(`the actual extraction reader rechecks a ${retained ? 'retained' : 'caller'} restriction after the model await`, async () => {
    let invalid = false;
    const restrict = () => invalid ? Promise.reject(new Error('Private late restriction detail')) : undefined;
    const owner = createKnowledgeExtractionOwner(retained ? {} : { assertCurrent: restrict });
    if (retained) owner.retain(restrict);
    const fake = fakePort(() => { invalid = true; return noulAnswer(0.99); }); installJudgmentPort(fake.port);
    await expect(readKnowledgeExtractionTextUsability(text, undefined, owner)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(fake.requests).toHaveLength(1);
    await Promise.resolve(); await Promise.resolve();
  });
}

test('a retained restriction returning a value cannot be admitted as a valid extraction owner', () => {
  const owner = createKnowledgeExtractionOwner();
  expect(() => owner.retain(() => false)).toThrow(KnowledgeExtractionJudgmentHoldError);
});

test('an actual synchronous extraction owner still permits the recorded readability result', async () => {
  let checks = 0;
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const owner = createKnowledgeExtractionOwner({ assertCurrent() { checks++; } });
  owner.retain(() => { checks++; });
  expect(await readKnowledgeExtractionTextUsability(text, undefined, owner)).toBe(true);
  expect(fake.requests).toHaveLength(1); expect(checks).toBeGreaterThan(1);
});
