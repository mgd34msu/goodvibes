import { afterEach, beforeEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { diagnoseInvalidGrant, type GrantDiagnosisInput } from '../platform/src/platform/google/grant-diagnosis.js';
import { readApiFailure, readGrantFailure } from '../platform/src/platform/google/failure-readings.js';
import { GoogleApiClient } from '../platform/src/platform/google/api-client.js';
import { GoogleTokenManager } from '../platform/src/platform/google/token-manager.js';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(prior); });
const grant: GrantDiagnosisInput = { googleError: 'Synthetic prose: access was revoked.', intendedAccount: null, signedInAccount: null, publishingStatus: 'testing', credentialOrigin: null };
function client(payload: unknown) {
  const tokens = new GoogleTokenManager({ clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', expiresAtMs: Date.now() + 3600000, scopes: [], tokenUri: 'https://oauth2.googleapis.com/token', origin: 'secret-store', location: 'fixture' }, {
    refresh: async () => { throw new Error('unexpected refresh'); },
  });
  let requests = 0;
  return { api: new GoogleApiClient(tokens, { async fetch() { requests++; return Response.json(payload, { status: 403 }); } }), count: () => requests };
}

test('Classic diagnostics retain actual account/HTTP facts and leave prose unassessed without decision requests', async () => {
  let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await readGrantFailure(grant)).toBe('unknown');
    expect(await readApiFailure({ error: { message: 'Missing scopes or disabled API' } })).toBe('unknown');
    expect(await diagnoseInvalidGrant(grant)).toMatchObject({ cause: 'unknown', provenance: 'classic', semanticAssessment: 'not-evaluated' });
    const local = await diagnoseInvalidGrant({ ...grant, intendedAccount: 'owner@example.com', signedInAccount: 'other@example.com' });
    expect(local).toMatchObject({ cause: 'account-mismatch', provenance: 'classic' });
    expect(local.semanticAssessment).toBeUndefined();
    const ambiguous = client({ error: { message: 'Missing scopes' } });
    expect(await ambiguous.api.getProfile()).toMatchObject({ ok: false, status: 403, reason: 'unclassified', provenance: 'classic', semanticAssessment: 'not-evaluated' });
    expect(ambiguous.count()).toBe(1);
    const protocol = client({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
    expect(await protocol.api.getProfile()).toMatchObject({ ok: false, reason: 'missing-scopes', provenance: 'classic' });
    expect(protocol.count()).toBe(1); expect(asks).toBe(0);
  });
});

test('Preferred diagnostic exhaustion preserves the failed API response and never retries the HTTP operation', async () => {
  let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new JudgmentError('unavailable', 'fixture exhausted'); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const api = client({ error: { message: 'Access blocked' } });
    expect(await api.api.getProfile()).toMatchObject({ ok: false, reason: 'unclassified', provenance: 'classic' });
    expect(api.count()).toBe(1); expect(asks).toBe(1);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
    expect((await diagnoseInvalidGrant(grant)).cause).toBe('unknown');
    expect(asks).toBe(1);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`diagnostic ${kind} cannot activate Preferred`, async () => {
  const failure = new JudgmentError(kind, 'fixture failure');
  installJudgmentPort({ model: 'fixture', async ask() { throw failure; } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readGrantFailure(grant)).rejects.toBe(failure);
    await expect(readApiFailure({ error: { message: 'denied' } })).rejects.toBe(failure);
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('a cancelled or changed diagnostic owner cannot turn an unavailable reading into a fallback', async () => {
  const abort = new AbortController();
  installJudgmentPort({ model: 'fixture', async ask() { abort.abort('synthetic private reason'); throw new JudgmentError('unavailable', 'fixture exhausted'); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readApiFailure({ error: { message: 'denied' } }, { signal: abort.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
  installJudgmentPort({ model: 'fixture', async ask() { Object.assign(grant, { googleError: 'changed' }); throw new JudgmentError('unavailable', 'fixture exhausted'); } });
  const original = structuredClone(grant);
  try {
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(readGrantFailure(grant)).rejects.toThrow();
      expect(decisionModelPolicyState().operation).toBe('decision');
    });
  } finally { Object.assign(grant, original); }
});
