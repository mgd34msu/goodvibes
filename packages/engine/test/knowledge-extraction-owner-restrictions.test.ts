/** Regression source authored during coding; execution deferred. */
import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createKnowledgeExtractionOwner } from '../platform/src/platform/knowledge/extraction-ownership.js';
import { KnowledgeExtractionJudgmentHoldError, readKnowledgeExtractionTextUsability } from '../platform/src/platform/knowledge/extraction-policy.js';

const previous = installJudgmentPort(undefined);
afterEach(() => { installJudgmentPort(previous); });
const text = 'The reference manual describes the original device controls.';

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
