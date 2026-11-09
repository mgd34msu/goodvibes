import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { assessOutwardContent, evaluateOutwardEffect, UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { grantOwnerApproval } from '../platform/src/platform/security/owner-approval.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test.each(['Classic - Off', 'Preferred'] as const)('%s requires exact owner approval when semantic derivation is unavailable', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port); restore = () => { installJudgmentPort(previous); };
  await withDecisionModelPolicy(() => policy, async () => {
    const ledger = new UntrustedContentLedger();
    const now = () => new Date('2026-11-06T12:00:00Z');
    ledger.record({ surface: 'email', origin: 'synthetic.example', at: now().toISOString(), content: 'An untrusted incoming request.' });
    const content = { to: 'recipient@example.test', body: 'Owner-reviewed outgoing message.' };
    const assessment = await assessOutwardContent(ledger, content);
    expect(assessment).toEqual({ kind: 'incomplete', findings: [], reason: 'decision-model-disabled' });
    const attempted = fake.requests.length;
    if (policy === 'Classic - Off') expect(attempted).toBe(0);
    else expect(attempted).toBeGreaterThan(0);
    const request = { toolName: 'email', action: 'email.send', description: 'sending the reviewed message' };
    const refused = await evaluateOutwardEffect({ request, ledger, content, now });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('Classic');
    const approval = grantOwnerApproval({ action: request.action, surface: 'owner-direct', content, now });
    expect((await evaluateOutwardEffect({ request, ledger, content, approval, now })).allowed).toBe(true);
    expect((await evaluateOutwardEffect({ request, ledger, content: { ...content, body: 'Changed after approval.' }, approval, now })).allowed).toBe(false);
    expect(fake.requests).toHaveLength(attempted);
  });
});
