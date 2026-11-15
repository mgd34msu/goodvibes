import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionModelsDisabledError, installJudgmentPort } from '@goodvibes-jev/engine/errors';
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

test.each(['Classic - Off', 'Preferred'] as const)('%s lists, raises, mirrors and delivers a date in its window from code alone', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => policy, async () => {
    const h = harness();
    const listed = await h.service.list();
    expect(listed.occasions[0]).toMatchObject({ nextOccurrence: '2026-03-14', daysUntil: 8, inLeadWindow: true,
      occasion: { title: 'Annual reunion', person: 'Jo', subject: 'unattributed' } });
    expect(h.service.listPlans().plans[0]).toMatchObject({ title: 'Lisbon', from: '2026-09-12', to: '2026-09-19' });
    const sweep = await h.service.sweep();
    expect(sweep).toMatchObject({ hold: null, mirrored: 1, delivered: true });
    expect(sweep.nudge?.subjects.map(subject => subject.title)).toEqual(['Annual reunion']);
    if (policy === 'Classic - Off') expect(sweep).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated' });
    const pending = await h.service.pending();
    expect(pending.nudge?.subjects.map(subject => subject.title)).toEqual(['Annual reunion']);
    // The lead boundary is spent: a second pass repeats neither the push nor the mirror.
    await h.service.sweep();
    expect(h.effects).toEqual({ mirrors: 1, deliveries: 1 });
    // A gift-giving line is never attributed by a model.
    expect(fake.requests).toHaveLength(0);
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
    expect(pending.nudge?.subjects[0]).toMatchObject({ occasionId: 'annual reunion', title: 'Annual reunion' });
    // An acknowledgement never replaces the no already given, and says so.
    expect(await h.service.acknowledge({ occasionId: 'annual reunion', source: 'conversation' })).toMatchObject({ ok: true, changed: false });
    const restarted = harness(h.root);
    expect((await restarted.service.list()).occasions.some(entry => entry.occasion.title === 'Our anniversary')).toBe(true);
    expect((await restarted.state.answerFor('annual reunion', '2026-03-14'))?.answer).toBe('no');
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

const REMEMBER_ONLY = profileText.replace('## Plans', "- Avery's birthday · 03-12 · annual · remember-only\n\n## Plans");

test('who a remember-only line is about is read once and stored; later lists, pulls and sweeps ask nothing', async () => {
  const fake = fakePort((name, question) => {
    if (name === 'subject') return choiceAnswer(question, 'owner', 0.999);
    throw new JudgmentError('unavailable', 'Only the subject reading is expected');
  }); install(fake.port);
  const root = mkdtempSync(join(tmpdir(), 'classic-occasions-')); writeFileSync(join(root, 'owner-profile.md'), REMEMBER_ONLY);
  const h = harness(root);
  const listed = await h.service.list();
  expect(listed.occasions.find(entry => entry.occasion.id === "avery's birthday")?.occasion.subject).toBe('owner');
  expect(fake.requests).toHaveLength(1);
  const sweep = await h.service.sweep();
  // The owner's own remember-only date is listed, never pushed.
  expect(sweep.nudge?.subjects.map(subject => subject.title)).toEqual(['Annual reunion']);
  await h.service.pending(); await h.service.list();
  const restarted = harness(root);
  await restarted.service.pending();
  expect(fake.requests).toHaveLength(1);
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request'] as const) {
  test(`a subject reading that fails (${kind}) leaves that line unattributed and every other date raised`, async () => {
    const fake = fakePort(() => { throw new JudgmentError(kind, 'Synthetic terminal failure'); }); install(fake.port);
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      const root = mkdtempSync(join(tmpdir(), 'classic-occasions-')); writeFileSync(join(root, 'owner-profile.md'), REMEMBER_ONLY);
      const h = harness(root);
      const listed = await h.service.list();
      expect(listed.occasions.find(entry => entry.occasion.id === "avery's birthday")?.occasion.subject).toBe('unattributed');
      const sweep = await h.service.sweep();
      expect(sweep.nudge?.subjects.map(subject => subject.title).sort()).toEqual(['Annual reunion', "Avery's birthday"]);
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
