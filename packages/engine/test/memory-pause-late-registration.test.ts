import { describe, expect, test } from 'bun:test';
import {
  CacheRegistry,
  MemoryGovernor,
  PauseController,
  memoryStatusLines,
  type MemorySample,
} from '../platform/src/platform/runtime/memory/index.ts';

const MB = 1024 * 1024;

function harness() {
  let rssBytes = 10 * MB;
  const pauses = new PauseController();
  const governor = new MemoryGovernor(
    { budgetMb: 100, elevatedPct: 60, highPct: 80, criticalPct: 95, tripwireRateMbPerSec: 25, tripwireSustainSec: 60 },
    {
      caches: new CacheRegistry(),
      pauses,
      sampler: (): MemorySample => ({ rssBytes, heapUsedBytes: rssBytes / 2, heapTotalBytes: rssBytes }),
      now: () => 0,
      gc: () => {},
      resolveSystemRamMb: () => 1024 * 1024,
      emitOps: () => {},
      writeReceipt: () => {},
      shutdown: () => {},
      exit: () => {},
    },
  );
  return { governor, pauses, setRssMb: (mb: number) => { rssBytes = mb * MB; } };
}

describe('a background job registered while memory pressure is high', () => {
  test('starts paused and is told so', () => {
    const h = harness();
    h.setRssMb(85);
    h.governor.sampleOnce();

    const told: string[] = [];
    h.pauses.register({ id: 'late-job', onPause: (reason) => told.push(reason) });

    expect(h.pauses.isPaused('late-job')).toBe(true);
    expect(told).toEqual(['memory-pressure:high']);
  });

  test('stays running when pressure is below the high tier', () => {
    const h = harness();
    h.setRssMb(65);
    h.governor.sampleOnce();
    h.pauses.register({ id: 'job' });
    expect(h.pauses.isPaused('job')).toBe(false);
  });

  test('resumes with the rest when pressure recovers', () => {
    const h = harness();
    h.setRssMb(85);
    h.governor.sampleOnce();
    h.pauses.register({ id: 'late-job' });
    h.setRssMb(10);
    h.governor.sampleOnce();
    expect(h.pauses.isPaused('late-job')).toBe(false);
  });
});

describe('the tripwire in the memory doctor output', () => {
  test('names the configured limit and labels the observed rate as current', () => {
    const h = harness();
    h.setRssMb(85);
    h.governor.sampleOnce();

    const snapshot = h.governor.snapshot();
    expect(snapshot.tripwire.thresholdMbPerSec).toBe(25);
    const line = memoryStatusLines(snapshot).find((l) => l.includes('tripwire'))!;
    expect(line).toContain('>25 MB/s');
    expect(line).toContain('currently');
  });
});
