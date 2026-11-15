import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  DecisionModelsDisabledError,
  DECISION_MODEL_POLICY_HEADER,
  installDecisionModelPolicyObserver,
  runDecisionOrClassic,
  type DecisionModelPolicyState,
} from '../errors/src/index.js';
import { installPlatformDecisionPolicyObserver } from '../platform/src/platform/runtime/decision-policy.js';
import { BrowserDecisionPolicy } from '../platform/src/browser-decision-policy.js';

const DECISION: DecisionModelPolicyState = { policy: 'Default - On', operation: 'decision', reason: null, revision: 1 };
const CLASSIC: DecisionModelPolicyState = { policy: 'Classic - Off', operation: 'classic', reason: 'selected', revision: 2 };

afterEach(() => {
  installDecisionModelPolicyObserver(() => DECISION);
});

// The observer is process-wide and these tests replace it. A later file sharing
// this process expects the platform's own observer, so install it again.
afterAll(() => { installPlatformDecisionPolicyObserver(); });

describe('runDecisionOrClassic', () => {
  test('runs the decision path while decision models are on, and never the classic one', async () => {
    installDecisionModelPolicyObserver(() => DECISION);
    const result = await runDecisionOrClassic(async () => 'decision', () => 'classic');
    expect(result).toBe('decision');
  });

  test('runs only the classic path under Classic operation', async () => {
    installDecisionModelPolicyObserver(() => CLASSIC);
    let decided = false;
    const result = await runDecisionOrClassic(async () => { decided = true; return 'decision'; }, () => 'classic');
    expect(result).toBe('classic');
    expect(decided).toBe(false);
  });

  test('refuses under Classic operation when the classic path may not resolve a settled refusal', async () => {
    installDecisionModelPolicyObserver(() => CLASSIC);
    await expect(runDecisionOrClassic(async () => 'decision', () => 'classic', () => false))
      .rejects.toBeInstanceOf(DecisionModelsDisabledError);
  });

  test('falls back to classic when a sibling operation switched the policy while the decision ran', async () => {
    let state = DECISION;
    installDecisionModelPolicyObserver(() => state);
    const result = await runDecisionOrClassic(async () => {
      state = CLASSIC;
      throw new DecisionModelsDisabledError('test feature');
    }, () => 'classic');
    expect(result).toBe('classic');
  });

  test('a disabled-feature error with the policy unchanged is the decision path\'s own failure', async () => {
    installDecisionModelPolicyObserver(() => DECISION);
    await expect(runDecisionOrClassic(async () => { throw new DecisionModelsDisabledError('test feature'); }, () => 'classic'))
      .rejects.toBeInstanceOf(DecisionModelsDisabledError);
  });

  test('falls back when the host classifies the failure as the decision model being unavailable', async () => {
    installDecisionModelPolicyObserver(() => DECISION, (error) => error instanceof RangeError);
    expect(await runDecisionOrClassic(async () => { throw new RangeError('unavailable'); }, () => 'classic')).toBe('classic');
    await expect(runDecisionOrClassic(async () => { throw new TypeError('bug'); }, () => 'classic')).rejects.toBeInstanceOf(TypeError);
  });

  test('does not fall back when the classic path is not allowed to repeat the work', async () => {
    installDecisionModelPolicyObserver(() => DECISION, () => true);
    await expect(runDecisionOrClassic(async () => { throw new Error('boom'); }, () => 'classic', () => false))
      .rejects.toThrow('boom');
  });
});

describe('BrowserDecisionPolicy', () => {
  const headers = (value: unknown) => ({ get: (name: string) => (name === DECISION_MODEL_POLICY_HEADER ? JSON.stringify(value) : null) });

  test('adopts a valid host observation, tells subscribers once, and ignores an unchanged repeat', () => {
    const policy = new BrowserDecisionPolicy();
    let changes = 0;
    policy.subscribe(() => { changes += 1; });
    policy.observe(headers(CLASSIC));
    policy.observe(headers(CLASSIC));
    expect(policy.snapshot()).toEqual(CLASSIC);
    expect(changes).toBe(1);
  });

  test('ignores an observation that contradicts itself and keeps the last good one', () => {
    const policy = new BrowserDecisionPolicy();
    policy.observe(headers(CLASSIC));
    policy.observe(headers({ ...CLASSIC, operation: 'decision' }));
    expect(policy.snapshot()).toEqual(CLASSIC);
  });

  test('reset forgets the observation and tells subscribers', () => {
    const policy = new BrowserDecisionPolicy();
    let changes = 0;
    policy.observe(headers(DECISION));
    policy.subscribe(() => { changes += 1; });
    policy.reset();
    policy.reset();
    expect(policy.snapshot()).toBeUndefined();
    expect(changes).toBe(1);
  });
});
