import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionModelsDisabledError, decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { OwnerProfileStore } from '../platform/src/platform/owner-profile/store.js';
import { OccasionStateStore } from '../platform/src/platform/occasions/state-store.js';
import { OccasionsService } from '../platform/src/platform/occasions/service.js';
import { OCCASIONS_DEFAULTS } from '../platform/src/platform/occasions/policy.js';
import { resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.js';

let previous: JudgmentPort | undefined, installed = false;
const roots: string[] = [];
beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function install(port: JudgmentPort | undefined) { previous = installJudgmentPort(port); installed = true; }
const now = Date.parse('2026-03-06T10:00:00Z');
const profileText = '# Owner profile\n\n## People\n\n- Jo likes pottery.\n\n## Important dates\n\n- Annual reunion · 03-14 · annual · gift-giving · for Jo\n\n## Plans\n\n- Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon\n';
function harness(root = mkdtempSync(join(tmpdir(), 'classic-occasions-'))) {
  if (!roots.includes(root)) roots.push(root);
  const path = join(root, 'owner-profile.md');
  if (!readFileIfPresent(path)) writeFileSync(path, profileText);
  const profile = new OwnerProfileStore({ path }); profile.loadSync();
  const state = new OccasionStateStore(join(root, 'occasions-state.json'));
  const effects = { mirrors: 0, deliveries: 0 };
  const service = new OccasionsService({
    profile: { importantDates: () => profile.importantDates(), plans: () => profile.plans(), person: (name, options) => profile.person(name, options), captureRead: () => profile.captureRead() },
    writer: { append: input => profile.append(input), forget: input => profile.forget(input) }, state,
    config: { get: key => key === 'daemon.timezone' ? 'Europe/London' : key === 'occasions.calendarMirror' ? true
      : (OCCASIONS_DEFAULTS as Record<string, unknown>)[key.replace(/^occasions\./, '')], set() {} },
    now: () => now,
    calendar: { mirror: async () => { effects.mirrors++; return 'synthetic-calendar-id'; } },
    deliverer: { deliver: async () => { effects.deliveries++; return 'synthetic-delivery-id'; } },
  });
  return { root, path, profile, state, service, effects };
}
function readFileIfPresent(path: string): string | undefined { try { return readFileSync(path, 'utf8'); } catch { return undefined; } }

test.each(['Classic - Off', 'Preferred'] as const)('%s lists explicit dates/plans and reaps without inferring subject or delivering/mirroring', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => policy, async () => {
    const h = harness();
    const listed = await h.service.list();
    expect(listed).toMatchObject({ provenance: 'classic', subjectAssessment: 'not-evaluated' });
    expect(listed.occasions[0]).toMatchObject({ nextOccurrence: '2026-03-14', daysUntil: 8,
      occasion: { title: 'Annual reunion', person: 'Jo', subject: 'unattributed' } });
    expect(h.service.listPlans().plans[0]).toMatchObject({ title: 'Lisbon', from: '2026-09-12', to: '2026-09-19' });
    const attempted = fake.requests.length;
    const sweep = await h.service.sweep();
    expect(sweep).toMatchObject({ hold: 'decision-models-disabled', provenance: 'classic', semanticAssessment: 'not-evaluated', mirrored: 0, delivered: false });
    expect(sweep.housekeeping?.sweptAt).toBe(now); expect(sweep.deliveries).toEqual([]);
    const pending = await h.service.pending();
    expect(pending).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated', nudge: null });
    expect(h.effects).toEqual({ mirrors: 0, deliveries: 0 }); expect(fake.requests).toHaveLength(attempted);
    expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
  });
});

test('Classic explicit confirmation, no/later/ack, raw pending items and restart keep native records usable without decisions', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const h = harness();
    const confirmed = await h.service.confirmOccasion({ title: 'Our anniversary', date: '09-12', kind: 'remember-only', person: 'Jane',
      surface: 'agent', said: 'Record our anniversary on September 12 as remember-only.', authority: 'owner-direct' });
    expect(confirmed.ok).toBe(true); expect(readFileSync(h.path, 'utf8')).toContain('Our anniversary');
    expect((await h.service.answer({ occasionId: 'annual reunion', answer: 'later' })).ok).toBe(true);
    expect((await h.service.answer({ occasionId: 'annual reunion', answer: 'no' })).ok).toBe(true);
    expect((await h.state.answerFor('annual reunion', '2026-03-14'))?.answer).toBe('no');
    await h.state.putOpenItem({ id: 'nudge:annual reunion@2026-03-14', kind: 'nudge', occasionId: 'annual reunion', occurrence: '2026-03-14',
      openedAt: now, lastRaisedAt: now, raiseCount: 0, servedBoundaries: [], dueOn: '2026-03-06', expiresAfter: '2026-03-14' });
    const pending = await h.service.pending();
    expect(pending.nudge).toBeNull(); expect(pending.open?.[0]).toMatchObject({ occasionId: 'annual reunion', title: 'Annual reunion' });
    expect((await h.service.acknowledge({ occasionId: 'annual reunion', source: 'explicit' })).ok).toBe(true);
    const restarted = harness(h.root);
    expect((await restarted.service.list()).occasions.some(entry => entry.occasion.title === 'Our anniversary')).toBe(true);
    expect((await restarted.state.answerFor('annual reunion', '2026-03-14'))?.answer).toBe('acknowledged');
    expect((await restarted.service.giftHistory('annual reunion'))).toEqual([]);
    expect(fake.requests).toHaveLength(0); expect(h.effects).toEqual({ mirrors: 0, deliveries: 0 });
  });
});

test('Classic new gift planning reports its semantic limitation without writing an interview, answer, mirror or delivery', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const h = harness();
    await expect(h.service.answer({ occasionId: 'annual reunion', answer: 'yes' })).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(await h.state.activeInterview('annual reunion', '2026-03-14')).toBeUndefined();
    expect(await h.state.answerFor('annual reunion', '2026-03-14')).toBeUndefined();
    expect(h.effects).toEqual({ mirrors: 0, deliveries: 0 }); expect(fake.requests).toHaveLength(0);
  });
});

test('Preferred nudge outage retains an already completed calendar mirror and never repeats it during fallback', async () => {
  const h = withDecisionModelPolicy(() => 'Classic - Off', () => harness());
  const fake = fakePort((name, question) => {
    if (name === 'subject') return choiceAnswer(question, 'other', 0.999);
    throw new JudgmentError('unavailable', 'Synthetic nudge wording outage');
  }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const sweep = await h.service.sweep();
    expect(sweep).toMatchObject({ hold: 'decision-models-disabled', mirrored: 1, delivered: false, provenance: 'classic' });
    expect(h.effects).toEqual({ mirrors: 1, deliveries: 0 });
    expect((await h.state.mirrorFor('annual reunion', '2026-03-14'))?.externalId).toBe('synthetic-calendar-id');
    const attempted = fake.requests.length;
    await h.service.sweep();
    expect(h.effects).toEqual({ mirrors: 1, deliveries: 0 }); expect(fake.requests).toHaveLength(attempted);
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) {
  test(`Preferred occasion ${kind} cannot become Classic semantic success or automatic effects`, async () => {
    const fake = fakePort(() => { throw new JudgmentError(kind, 'Synthetic terminal failure'); }); install(fake.port);
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      const h = harness();
      await expect(h.service.list()).rejects.toThrow();
      expect(decisionModelPolicyState().operation).toBe('decision'); expect(h.effects).toEqual({ mirrors: 0, deliveries: 0 });
    });
  });
}

test('Classic occasion cancellation and native source revocation still stop state publication', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const h = harness(), controller = new AbortController(); controller.abort();
    await expect(h.service.sweep({ signal: controller.signal })).rejects.toThrow();
    await expect(h.service.answer({ occasionId: 'annual reunion', answer: 'no' }, { assertCurrent: () => { throw new Error('Native owner retired'); } })).rejects.toThrow();
    expect(await h.state.answerFor('annual reunion', '2026-03-14')).toBeUndefined();
    expect(h.effects).toEqual({ mirrors: 0, deliveries: 0 }); expect(fake.requests).toHaveLength(0);
  });
});
