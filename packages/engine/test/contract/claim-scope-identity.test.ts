/** Source regression UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import { answerClaimScopes, completeAnswerClaimCoverage, recordAnswerClaimReview } from '../../sdk/src/platform/contract/final-answer-claims.js';

test('fresh actual claim coverage uses its exact original immutable answer without hashing the same passages again', () => {
  const output = 'A supported claim with its complete surrounding qualification.\n'.repeat(200);
  const scopes = answerClaimScopes(output);
  const hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const reviews = scopes.map((scope, index) => recordAnswerClaimReview(scope, { stateHash: 'actual-recorded-state', decisionId: `decision-${index}`,
      reading: { probability: 0.01, verdict: 'no', outcome: 'act' } }));
    expect(completeAnswerClaimCoverage(output, reviews)).toBe(true);
    expect(completeAnswerClaimCoverage(output.slice(0, -1) + 'x', reviews)).toBe(false);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(Object.isFrozen(reviews[0])).toBe(true);
    expect(JSON.stringify(reviews)).not.toContain('A supported claim');
    expect(() => recordAnswerClaimReview({ ...scopes[0]! }, { stateHash: 'copied', decisionId: 'copied', reading: { probability: 0.01, verdict: 'no', outcome: 'act' } })).toThrow('original host scope');
    // Actual saved/read-back rows carry no private current-input provenance:
    // they retain the real logged-question commitment verification path.
    expect(completeAnswerClaimCoverage(output, structuredClone(reviews))).toBe(true);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(reviews.length);
  } finally { hashes.mockRestore(); }
});


test('invalid claim ranges and nonadvancing chunk sizes refuse before hashing rather than looping', () => {
  const hashes = spyOn(Bun.CryptoHasher, 'hash');
  try {
    for (const limit of [0, -1, NaN, Infinity, 4_001, 1.5]) expect(() => answerClaimScopes('answer', 0, 6, limit)).toThrow(RangeError);
    for (const [start, end] of [[-1, 6], [0, 7], [4, 3], [0.5, 6], [0, NaN]]) expect(() => answerClaimScopes('answer', start, end)).toThrow(RangeError);
    expect(hashes.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashes.mockRestore(); }
  expect(completeAnswerClaimCoverage('', answerClaimScopes(''))).toBe(true);
});
