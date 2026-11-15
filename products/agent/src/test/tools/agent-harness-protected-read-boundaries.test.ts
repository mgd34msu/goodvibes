import { afterAll, describe, expect, test } from 'bun:test';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { TASK_ROUTES } from '@goodvibes-jev/engine/platform/platform/routing';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { captureCatalogMethods, combineCatalogGuards } from '../../tools/agent-harness-catalog-ranking.ts';
import { RetainedGuards } from '../../tools/agent-harness-retained-guards.ts';
import { withModelReadingSource, type ModelReadingOptions } from '../../tools/agent-harness-model-reading-source.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

/**
 * A protected read proves its snapshot current once and then checks, at every
 * boundary, only what can still change. Each case changes one of those things in
 * the middle of a read and requires the very next boundary to refuse.
 */
describe('a change in the middle of a protected read stops publication at the next boundary', () => {
  const read = <T, R>(source: T, options: ModelReadingOptions, consume: Parameters<typeof withModelReadingSource<T, R>>[2]) =>
    withModelReadingSource(source, { sourceOwner: ordinaryResearchOwner(), ...options }, consume);

  test('an unchanged read publishes, so every refusal below is caused by its change', async () => {
    const result = await read({ text: 'plain note' }, {}, async (captured, reading) => { reading.assertCurrent?.(); return captured.text; });
    expect(result).toBe('plain note');
  });

  test('abort', async () => {
    const controller = new AbortController();
    let published = false;
    await expect(read({ text: 'plain note' }, { signal: controller.signal }, async (_captured, reading) => {
      reading.assertCurrent?.();
      controller.abort();
      reading.assertCurrent?.();
      published = true;
    })).rejects.toThrow();
    expect(published).toBe(false);
  });

  test('an abort after the last boundary still refuses the result', async () => {
    const controller = new AbortController();
    await expect(read({ text: 'plain note' }, { signal: controller.signal }, async () => { controller.abort(); return 'published'; })).rejects.toThrow();
  });

  test('the caller revoking its authority', async () => {
    let revoked = false;
    await expect(read({ text: 'plain note' }, { assertCurrent: () => { if (revoked) throw new Error('authority revoked'); } },
      async (_captured, reading) => { reading.assertCurrent?.(); revoked = true; reading.assertCurrent?.(); return 'published'; })).rejects.toThrow();
  });

  test('the caller revoking its authority after the last boundary', async () => {
    let revoked = false;
    await expect(read({ text: 'plain note' }, { assertCurrent: () => { if (revoked) throw new Error('authority revoked'); } },
      async () => { revoked = true; return 'published'; })).rejects.toThrow();
  });

  test('a swapped options slot', async () => {
    const options: { assertCurrent?: () => void; sourceOwner: ReturnType<typeof ordinaryResearchOwner> } = { sourceOwner: ordinaryResearchOwner(), assertCurrent: () => {} };
    await expect(withModelReadingSource({ text: 'plain note' }, options, async (_captured, reading) => {
      reading.assertCurrent?.();
      options.assertCurrent = () => {};
      reading.assertCurrent?.();
      return 'published';
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a replaced owner method', async () => {
    const owner = Object.create(ordinaryResearchOwner()) as ReturnType<typeof ordinaryResearchOwner>;
    await expect(withModelReadingSource({ text: 'plain note' }, { sourceOwner: owner }, async (_captured, reading) => {
      reading.assertCurrent?.();
      Object.defineProperty(owner, 'project', { value: () => [], configurable: true });
      reading.assertCurrent?.();
      return 'published';
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a mutated source', async () => {
    const source = { text: 'plain note', nested: { count: 1 } };
    await expect(read(source, {}, async (_captured, reading) => {
      reading.assertCurrent?.();
      source.nested.count = 2;
      reading.assertCurrent?.();
      return 'published';
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a released handle: the read cannot be used after it settled', async () => {
    let boundary: (() => void) | undefined;
    await read({ text: 'plain note' }, {}, async (_captured, reading) => { boundary = reading.assertCurrent; return 'done'; });
    expect(boundary).toBeDefined();
    expect(() => boundary?.()).toThrow(ToolInputProjectionError);
  });

  test('a retained guard that no longer holds', async () => {
    let stale = false;
    await expect(read({ text: 'plain note' }, {}, async (_captured, reading) => {
      reading.retainCurrent?.(() => { if (stale) throw new ToolInputProjectionError('held'); }, 'test.source');
      reading.assertCurrent?.();
      stale = true;
      reading.assertCurrent?.();
      return 'published';
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a retained guard that went stale before it is replaced is not forgotten', async () => {
    let stale = false;
    await expect(read({ text: 'plain note' }, {}, async (_captured, reading) => {
      reading.retainCurrent?.(() => { if (stale) throw new ToolInputProjectionError('held'); }, 'test.source');
      stale = true;
      reading.retainCurrent?.(() => {}, 'test.source');
      return 'published';
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a key retained again keeps one guard however often it is retained', async () => {
    const runs: number[] = [];
    await read({ text: 'plain note' }, {}, async (_captured, reading) => {
      for (let index = 0; index < 5; index++) {
        runs.push(0);
        reading.retainCurrent?.(() => { runs[index]!++; }, 'test.repeated');
      }
      for (let boundary = 0; boundary < 4; boundary++) reading.assertCurrent?.();
      return 'published';
    });
    // Each earlier guard ran once, when it was replaced; only the last stays live.
    expect(runs.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(runs[4]).toBeGreaterThanOrEqual(4);
  });
});

describe('retained guards', () => {
  test('a guard without a key is kept, and the same guard is kept once', () => {
    const guards = new RetainedGuards();
    const guard = () => {};
    guards.add(guard); guards.add(guard); guards.add(() => {});
    expect(guards.size).toBe(2);
  });

  test('a replaced guard must still hold at the moment it is dropped', () => {
    const guards = new RetainedGuards();
    guards.add(() => { throw new ToolInputProjectionError('held'); }, 'source');
    expect(() => guards.add(() => {}, 'source')).toThrow(ToolInputProjectionError);
  });
});

describe('slots proven unchangeable are not compared again, and every other slot still is', () => {
  test('a frozen subject needs no further comparison', () => {
    const guard = captureCatalogMethods(Object.freeze({ run() {} }), ['run']);
    expect(combineCatalogGuards([guard, guard])).toBe(guard);
    expect(() => guard()).not.toThrow();
  });

  test('a mutable subject is compared at each call', () => {
    const subject = { run() {} };
    const guard = captureCatalogMethods(subject, ['run']);
    expect(() => guard()).not.toThrow();
    subject.run = () => {};
    expect(() => guard()).toThrow(ToolInputProjectionError);
  });

  test('a frozen subject whose slot comes from a mutable prototype is still compared', () => {
    const prototype = { run() {} };
    const subject = Object.freeze(Object.create(prototype) as { run(): void });
    const guard = captureCatalogMethods(subject, ['run']);
    expect(() => guard()).not.toThrow();
    prototype.run = () => {};
    expect(() => guard()).toThrow(ToolInputProjectionError);
  });

  test('a slot absent from a frozen subject is refused once a mutable prototype gains it', () => {
    const prototype: { run?: () => void } = {};
    const subject = Object.freeze(Object.create(prototype) as object);
    const guard = captureCatalogMethods(subject, ['run']);
    expect(() => guard()).not.toThrow();
    prototype.run = () => {};
    expect(() => guard()).toThrow(ToolInputProjectionError);
  });

  test('a slot absent from an extensible subject is refused once it appears', () => {
    const subject: { run?: () => void } = {};
    const guard = captureCatalogMethods(subject, ['run']);
    subject.run = () => {};
    expect(() => guard()).toThrow(ToolInputProjectionError);
  });

  test('a prototype swapped under a live slot is refused', () => {
    const subject = Object.create({ run() {} }) as { run(): void };
    const guard = captureCatalogMethods(subject, ['run']);
    Object.setPrototypeOf(subject, { run() {} });
    expect(() => guard()).toThrow(ToolInputProjectionError);
  });
});

describe('static catalogs are fixed data', () => {
  test('the workspace categories, their actions and the task routes are frozen throughout', () => {
    expect(Object.isFrozen(AGENT_WORKSPACE_CATEGORIES)).toBe(true);
    for (const category of AGENT_WORKSPACE_CATEGORIES) {
      expect(Object.isFrozen(category)).toBe(true);
      expect(Object.isFrozen(category.actions)).toBe(true);
      for (const action of category.actions) expect(Object.isFrozen(action)).toBe(true);
    }
    expect(Object.isFrozen(TASK_ROUTES)).toBe(true);
    for (const route of TASK_ROUTES) expect(Object.isFrozen(route)).toBe(true);
  });
});
