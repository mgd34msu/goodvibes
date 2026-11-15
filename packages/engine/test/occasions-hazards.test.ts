/**
 * occasions-hazards.test.ts
 *
 * What the occasions machinery must not do to an owner's records or to what
 * they are told: delete history because the profile could not be read, keep a
 * malformed answer that wedges the pull, close an item the owner only
 * acknowledged, lose an interview answer to a concurrent one, spend a push
 * boundary on a delivery that never happened, or stay silent about a conflict.
 */
import { useOccasionReadings } from './helpers/occasion-readings.ts';
useOccasionReadings();
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../platform/src/platform/owner-profile/store.ts';
import { OccasionStateStore } from '../platform/src/platform/occasions/state-store.ts';
import { OccasionsService, type OccasionCalendarMirror, type OccasionNudgeDeliverer } from '../platform/src/platform/occasions/service.ts';
import { OCCASIONS_DEFAULTS } from '../platform/src/platform/occasions/policy.ts';
import type { OccasionNudge } from '../platform/src/platform/occasions/types.ts';
import { startOccasionSweepTicker, type TickerScheduler } from '../platform/src/platform/occasions/ticker.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.ts';

beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = `# Owner profile

## Location

timezone: Europe/London

## People

- Sarah is my sister. She has been doing pottery all year and loves it.

## Important dates

- Sarah's birthday · 03-14 · annual · gift-giving · for Sarah
- Dad · 11-02 · annual · remember-only
`;

const SARAH = "sarah's birthday";

interface Harness {
  readonly service: OccasionsService;
  readonly state: OccasionStateStore;
  readonly pushes: { readonly channel: string; readonly nudge: OccasionNudge }[];
  readonly refuse: Set<string>;
  /** While true the profile reports no dates at all, as an unloaded or unreadable profile does. */
  hideDates: boolean;
  setNow(ms: number): void;
  setConfig(key: string, value: unknown): void;
}

function harness(options: { readonly profileText?: string; readonly calendar?: OccasionCalendarMirror } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-occasions-hazards-'));
  dirs.push(dir);
  const profilePath = join(dir, 'owner-profile.md');
  writeFileSync(profilePath, options.profileText ?? PROFILE, 'utf-8');
  const profile = new OwnerProfileStore({ path: profilePath });
  profile.loadSync();
  const state = new OccasionStateStore(join(dir, 'occasions-state.json'));
  const pushes: { channel: string; nudge: OccasionNudge }[] = [];
  const refuse = new Set<string>();
  const deliverer: OccasionNudgeDeliverer = {
    deliver: async ({ channel, nudge }) => {
      if (refuse.has(channel)) throw new Error(`${channel} is not accepting messages`);
      pushes.push({ channel, nudge });
      return `delivery-${pushes.length}`;
    },
  };
  const overrides = new Map<string, unknown>([['daemon.timezone', 'Europe/London'], ['occasions.nudgeChannel', 'telegram']]);
  let now = Date.parse('2026-03-06T10:00:00Z');
  const result = {
    pushes, refuse, state, hideDates: false,
    setNow: (ms: number) => { now = ms; },
    setConfig: (key: string, value: unknown) => { overrides.set(key, value); },
  } as unknown as Harness;
  const service = new OccasionsService({
    profile: {
      importantDates: () => (result.hideDates ? [] : profile.importantDates()),
      plans: () => profile.plans(),
      person: (name, readOptions) => profile.person(name, readOptions),
      captureRead: () => profile.captureRead(),
    },
    writer: { append: (input) => profile.append(input), forget: (input) => profile.forget(input) },
    state,
    config: {
      get: (key) => {
        if (overrides.has(key)) return overrides.get(key);
        const short = key.startsWith('occasions.') ? key.slice('occasions.'.length) : key;
        return (OCCASIONS_DEFAULTS as Record<string, unknown>)[short];
      },
      set: () => undefined,
    },
    deliverer,
    ...(options.calendar === undefined ? {} : { calendar: options.calendar }),
    now: () => now,
  });
  return Object.assign(result, { service });
}

describe('housekeeping when the profile declares nothing', () => {
  test('an unreadable profile does not delete answers, gift history or open items', async () => {
    const h = harness();
    await h.service.sweep();
    await h.service.acknowledge({ occasionId: SARAH, source: 'explicit' });
    await h.state.recordGift({ occasionId: SARAH, occurrence: '2025-03-14', landedOn: 'a bowl', recordedAt: 1 });
    expect(await h.state.acknowledgements()).toHaveLength(1);
    const itemsBefore = (await h.state.openItems()).length;
    expect(itemsBefore).toBeGreaterThan(0);

    h.hideDates = true;
    const outcome = await h.service.sweep();
    h.hideDates = false;

    expect(outcome.housekeeping?.orphanedRecords).toBe(0);
    expect(await h.state.acknowledgements()).toHaveLength(1);
    expect(await h.state.giftHistory(SARAH)).toHaveLength(1);
    expect((await h.state.openItems()).length).toBe(itemsBefore);
  });
});

describe('an occurrence is a date', () => {
  test('a free-form occurrence is refused and cannot wedge the pull', async () => {
    const h = harness();
    await h.service.sweep();
    const acknowledged = await h.service.acknowledge({ occasionId: SARAH, occurrence: 'tomorrow', source: 'explicit' });
    expect(acknowledged.ok).toBe(false);
    expect(acknowledged.reason).toContain('ISO date');
    const answered = await h.service.answer({ occasionId: SARAH, answer: 'no', occurrence: 'next week' });
    expect(answered.ok).toBe(false);
    expect(await h.state.acknowledgements()).toHaveLength(0);
    await expect(h.service.pending()).resolves.toBeDefined();
  });

  test('the store refuses a non-date occurrence even when a caller skips the service', async () => {
    const h = harness();
    await expect(h.state.recordAnswer({
      id: 'x@tomorrow', occasionId: SARAH, occurrence: 'tomorrow', answer: 'no', answeredAt: 1,
    })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('acknowledged through the answer verb', () => {
  test('leaves the open item standing and listed as acknowledged', async () => {
    const h = harness();
    await h.service.sweep();
    expect(await h.state.openItems()).toHaveLength(1);
    const result = await h.service.answer({ occasionId: SARAH, answer: 'acknowledged' });
    expect(result.ok).toBe(true);
    expect(await h.state.openItems()).toHaveLength(1);
    const pending = await h.service.pending();
    expect(pending.acknowledged.map((entry) => entry.occasionId)).toEqual([SARAH]);
  });
});

describe('conflicts and unfinished interviews are delivered', () => {
  test('a date conflict is pushed as a line that names the occasion and no date', async () => {
    const h = harness({
      profileText: '# P\n\n## Important dates\n\n'
        + '- Mum · 08-02 · annual · gift-giving\n'
        + '- Mum · 08-03 · annual · gift-giving\n',
    });
    const outcome = await h.service.sweep();
    expect(outcome.conflictMessages).toHaveLength(1);
    const lines = h.pushes.map((push) => push.nudge.message);
    expect(lines.some((line) => line.includes('different dates recorded for Mum'))).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/08-0\d/);
    expect(outcome.deliveries.some((entry) => entry.delivered)).toBe(true);
  });

  test('an unfinished gift interview is pushed when the sweep resumes it', async () => {
    const h = harness();
    await h.service.sweep();
    await h.service.answer({ occasionId: SARAH, answer: 'yes' });
    h.pushes.length = 0;
    h.setNow(Date.parse('2026-03-08T10:00:00Z'));
    const outcome = await h.service.sweep();
    expect(outcome.resumedInterviews).toHaveLength(1);
    expect(h.pushes.some((push) => push.nudge.message.includes("Sarah's birthday") && push.nudge.message.includes('gift planning'))).toBe(true);
  });
});

describe('the lead boundary is spent by a push that landed', () => {
  test('a destination that refuses leaves the boundary for the next sweep', async () => {
    const h = harness();
    h.refuse.add('telegram');
    const failed = await h.service.sweep();
    expect(failed.delivered).toBe(false);
    const items = await h.state.openItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.servedBoundaries).toEqual([]);

    h.refuse.delete('telegram');
    const retried = await h.service.sweep();
    expect(retried.delivered).toBe(true);
    expect(h.pushes).toHaveLength(1);
    expect((await h.state.openItems())[0]!.servedBoundaries).toEqual(['lead']);

    const again = await h.service.sweep();
    expect(again.nudge).toBeNull();
    expect(h.pushes).toHaveLength(1);
  });

  test('with no destination at all the boundary is still spent, so the pull is not recomposed forever', async () => {
    const h = harness();
    h.setConfig('occasions.nudgeChannel', '');
    await h.service.sweep();
    expect((await h.state.openItems())[0]!.servedBoundaries).toEqual(['lead']);
  });
});

describe('the calendar mirror', () => {
  test('one occasion failing to mirror does not stop the sweep from delivering', async () => {
    const attempts: string[] = [];
    const h = harness({ calendar: { mirror: async ({ occasion }) => { attempts.push(occasion.id); throw new Error('calendar unreachable'); } } });
    h.setConfig('occasions.calendarMirror', true);
    const outcome = await h.service.sweep();
    expect(attempts.length).toBeGreaterThan(0);
    expect(outcome.mirrored).toBe(0);
    expect(outcome.delivered).toBe(true);
  });
});

describe('concurrent writes to one record', () => {
  test('two interview answers for different steps are both kept', async () => {
    const h = harness();
    await h.service.sweep();
    const started = (await h.service.answer({ occasionId: SARAH, answer: 'yes' })).interview!;
    const [first, second] = started.steps;
    await Promise.all([
      h.service.answerInterview({ interviewId: started.interviewId, stepId: first!.id, text: 'pottery' }),
      h.service.answerInterview({ interviewId: started.interviewId, stepId: second!.id, text: 'something small' }),
    ]);
    const stored = await h.state.interview(started.interviewId);
    expect(stored!.answers.map((answer) => answer.stepId).sort()).toEqual([first!.id, second!.id].sort());
  });

  test('two concurrent open-item changes each build on the other', async () => {
    const h = harness();
    await h.service.sweep();
    const [item] = await h.state.openItems();
    const bump = (existing: typeof item) => ({ ...existing!, raiseCount: existing!.raiseCount + 1 });
    await Promise.all([
      h.state.settleOpenItem(item!.id, bump),
      h.state.settleOpenItem(item!.id, bump),
    ]);
    expect((await h.state.openItem(item!.id))!.raiseCount).toBe(item!.raiseCount + 2);
  });
});

describe('an interview answer for a step that does not exist', () => {
  test('is refused with the next step named, and nothing is recorded', async () => {
    const h = harness();
    await h.service.sweep();
    const started = (await h.service.answer({ occasionId: SARAH, answer: 'yes' })).interview!;
    const ackBefore = await h.state.acknowledgements();
    await expect(h.service.answerInterview({ interviewId: started.interviewId, stepId: 'no-such-step', text: 'x' }))
      .rejects.toThrow(started.nextStep!.id);
    expect((await h.state.interview(started.interviewId))!.answers).toHaveLength(0);
    expect(await h.state.acknowledgements()).toEqual(ackBefore);
  });
});

describe('the first load of the state file', () => {
  test('a caller that gives up does not fail the caller waiting on the same load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-occasions-load-'));
    dirs.push(dir);
    const state = new OccasionStateStore(join(dir, 'state.json'));
    const controller = new AbortController();
    const giving = state.prepareRead({ signal: controller.signal });
    const waiting = state.prepareRead();
    controller.abort();
    await expect(giving).rejects.toBeDefined();
    await expect(waiting).resolves.toBeUndefined();
    expect(await state.acknowledgements()).toEqual([]);
  });
});

describe('the sweep ticker', () => {
  test('an interval setting that throws does not end the loop', async () => {
    let pending: (() => void) | null = null;
    const scheduler: TickerScheduler = {
      setTimeout: (handler) => { pending = handler; return handler; },
      clearTimeout: () => { pending = null; },
    };
    let passes = 0;
    let throwOnce = true;
    const errors: unknown[] = [];
    const ticker = startOccasionSweepTicker({
      sweep: async () => { passes += 1; },
      intervalMs: () => { if (throwOnce) { throwOnce = false; throw new Error('settings unreadable'); } return 1000; },
      scheduler,
      onError: (error) => errors.push(error),
    });
    // The failed read at start-up was reported and the loop was armed anyway.
    expect(errors).toHaveLength(1);
    const due = pending as unknown as () => void;
    pending = null;
    due();
    await Promise.resolve(); await Promise.resolve();
    expect(passes).toBe(1);
    // And it armed again after the pass.
    expect(pending).not.toBeNull();
    ticker.stop();
  });
});
