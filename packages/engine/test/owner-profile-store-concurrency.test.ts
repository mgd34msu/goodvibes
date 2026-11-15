/**
 * The owner profile store under overlapping work: reloads that overlap a
 * change, a slow read that overlaps our own write, two writes in one process,
 * an unreadable file while values must stay masked, and two installs of the
 * process-wide consumers.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { OwnerProfileStore } from '../platform/src/platform/owner-profile/store.ts';
import type { ProfilePersistIo } from '../platform/src/platform/owner-profile/writer.ts';
import { installOwnerProfileConsumers, memoizedRedactionValues } from '../platform/src/platform/owner-profile/consumers.ts';
import { openTierContextBlock, registerOpenTierContextBlock } from '../platform/src/platform/owner-profile/context-block.ts';
import { registerSignupBaseAddressFallback } from '../platform/src/platform/google/account-registry.ts';
import { registerProfileRedactionValues } from '../platform/src/platform/utils/redaction.ts';
import { MAX_PEOPLE_LINES_PER_READING, ProfilePersonReadingHeldError } from '../platform/src/platform/owner-profile/person-reading.ts';
import { parseProfileDocument } from '../platform/src/platform/owner-profile/document.ts';
import { useSecurityReadings } from './helpers/security-readings.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.ts';

useSecurityReadings();
beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });

const dirs: string[] = [];
function tempProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-profile-concurrency-'));
  dirs.push(dir);
  const path = join(dir, 'owner-profile.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}
afterEach(() => {
  registerSignupBaseAddressFallback(null);
  registerProfileRedactionValues(null);
  registerOpenTierContextBlock(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER = { authority: 'owner-direct', surface: 'tui', said: 'set it to this' } as const;
const profileWith = (city: string) => ['## Location', '', `city: ${city}`, ''].join('\n');

function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }

/** Hold the first read of the profile file after it has read its bytes, so a test can change things while it is in flight. */
function holdFirstRead() {
  const entered = deferred(), release = deferred();
  const original = fsp.readFile.bind(fsp);
  let held = false;
  const spy = spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
    const bytes = await original(...args);
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return bytes;
  }) as typeof fsp.readFile);
  return { entered: entered.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

type Reloader = { reloadIfChanged(): Promise<void> };

describe('reload while a reload is in flight', () => {
  test('a second change arriving during the first reload is adopted', async () => {
    const path = tempProfile(profileWith('A'));
    const store = new OwnerProfileStore({ path });
    await store.load();
    writeFileSync(path, profileWith('BB'), 'utf-8');
    const hold = holdFirstRead();
    try {
      const first = (store as unknown as Reloader).reloadIfChanged();
      await hold.entered;
      writeFileSync(path, profileWith('CCC'), 'utf-8');
      await (store as unknown as Reloader).reloadIfChanged(); // arrives while the first is reading
      hold.release();
      await first;
    } finally { hold.restore(); }
    expect(store.get('location.city')?.value).toBe('CCC');
  });
});

describe('a slow read that overlaps our own write', () => {
  test('does not put the pre-write text back', async () => {
    const path = tempProfile(profileWith('A'));
    const store = new OwnerProfileStore({ path });
    await store.load();
    const hold = holdFirstRead();
    try {
      const reload = store.load(); // reads the old bytes, then waits
      await hold.entered;
      const written = await store.set({ ...OWNER, fieldId: 'location.city', value: 'Lansing, MI', date: '2026-07-27' });
      expect(written.ok).toBe(true);
      hold.release();
      await reload;
    } finally { hold.restore(); }
    expect(store.get('location.city')?.value).toBe('Lansing, MI');
  });
});

describe('two writes in one process', () => {
  test('both values are in the file when the second starts while the first is still writing', async () => {
    const path = tempProfile(['## Location', '', 'timezone: America/Detroit', 'city: A', ''].join('\n'));
    const gate = deferred();
    let writes = 0;
    const io: ProfilePersistIo = {
      mkdir: async () => undefined,
      writeFile: async (tmpPath, content) => { writes += 1; if (writes === 1) await gate.promise; writeFileSync(tmpPath, content, 'utf-8'); },
      rename: async (from, to) => { writeFileSync(to, readFileSync(from, 'utf-8')); rmSync(from); },
      remove: async (tmpPath) => { rmSync(tmpPath, { force: true }); },
    };
    const store = new OwnerProfileStore({ path, persistIo: io });
    await store.load();
    const first = store.set({ ...OWNER, fieldId: 'location.city', value: 'Lansing, MI', date: '2026-07-27' });
    const second = store.set({ ...OWNER, fieldId: 'location.timezone', value: 'Europe/Berlin', date: '2026-07-27' });
    // Give the second write every chance to start; it must not reach the disk while the first is mid-write.
    for (let turn = 0; turn < 100 && writes < 2; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    const bytes = readFileSync(path, 'utf-8');
    expect(bytes).toContain('city: Lansing, MI');
    expect(bytes).toContain('timezone: Europe/Berlin');
    expect(store.get('location.city')?.value).toBe('Lansing, MI');
    expect(store.get('location.timezone')?.value).toBe('Europe/Berlin');
  });
});

describe('an owner edit that lands while the temp file is being written', () => {
  test('is not renamed over: the write is refused and the owner text stays', async () => {
    const path = tempProfile(['## Location', '', 'city: A', ''].join('\n'));
    const ownerText = ['## Location', '', 'city: Owner Edit In The Middle', ''].join('\n');
    let renamed = false;
    const io: ProfilePersistIo = {
      mkdir: async () => undefined,
      writeFile: async (tmpPath, content) => { writeFileSync(tmpPath, content, 'utf-8'); writeFileSync(path, ownerText, 'utf-8'); },
      rename: async (from, to) => { renamed = true; writeFileSync(to, readFileSync(from, 'utf-8')); rmSync(from); },
      remove: async (tmpPath) => { rmSync(tmpPath, { force: true }); },
    };
    const store = new OwnerProfileStore({ path, persistIo: io });
    await store.load();
    const result = await store.set({ ...OWNER, fieldId: 'location.city', value: 'Lansing, MI', date: '2026-07-27' });
    expect(result.ok).toBe(false);
    expect(renamed).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(ownerText);
  });
});

describe('redaction values while the profile cannot be read', () => {
  const ADDRESS = '200 Office Way, Lansing, MI 48933, US';
  const document = ['## Commerce', '', `shipping address: ${ADDRESS}`, ''].join('\n');

  test('keep masking the last values read until the file reads again', async () => {
    const path = tempProfile(document);
    const store = new OwnerProfileStore({ path });
    await store.load();
    const values = memoizedRedactionValues(store);
    expect(values().guarded).toContain(ADDRESS);

    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    expect((await store.load()).kind).toBe('unavailable');
    expect(values().guarded).toContain(ADDRESS);

    writeFileSync(path, '', 'utf-8'); // the owner really emptied the file
    expect((await store.load()).kind).toBe('loaded');
    expect(values().guarded).toEqual([]);
  });
});

describe('two installs of the process-wide consumers', () => {
  test('disposing the first leaves the second one\'s open-tier block in place', async () => {
    const make = async (city: string) => {
      const store = new OwnerProfileStore({ path: tempProfile(profileWith(city)) });
      await store.load();
      return store;
    };
    const host = { attachProfileFallback: () => undefined, consumerFallbackEnabled: () => true, injectOpenTierEnabled: () => true };
    const disposeFirst = installOwnerProfileConsumers(await make('Detroit'), host);
    const disposeSecond = installOwnerProfileConsumers(await make('Lansing'), host);
    expect(openTierContextBlock()).toContain('Lansing');
    disposeFirst();
    expect(openTierContextBlock()).toContain('Lansing');
    disposeSecond();
    expect(openTierContextBlock()).toBe('');
  });
});

describe('a named-person reading over a long People section', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(undefined); });
  afterEach(() => { installJudgmentPort(previous); });

  test('is refused before any model request past the line limit', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    installJudgmentPort(fake.port);
    const people = Array.from({ length: MAX_PEOPLE_LINES_PER_READING + 1 }, (_, index) => `- Person ${index}, friend`).join('\n');
    const store = new OwnerProfileStore({ path: tempProfile(`## People\n${people}\n`) });
    store.loadSync();
    await expect(store.person('Person 3')).rejects.toBeInstanceOf(ProfilePersonReadingHeldError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('the documented profile file', () => {
  test('the example in the design document parses with its provenance', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'owner-profile.md'), 'utf-8');
    const heading = doc.indexOf('### 4.1');
    const start = doc.indexOf('```markdown\n', heading) + '```markdown\n'.length;
    const sample = doc.slice(start, doc.indexOf('\n```', start));
    const projection = parseProfileDocument({ path: '/profile.md', text: sample, exists: true });
    expect(projection.fields.get('commerce.shippingAddress')?.provenance).toEqual({ surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' });
  });
});
