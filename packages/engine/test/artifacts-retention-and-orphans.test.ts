import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('artifact retention', () => {
  test('a negative retention gets the default instead of never expiring', async () => {
    const store = new ArtifactStore({ rootDir: root(), defaultRetentionMs: DAY_MS, maxRetentionMs: 50 * DAY_MS });
    const negative = await store.create({ text: 'a', retentionMs: -1 });
    expect(negative.expiresAt).toBeDefined();
    // The default (one day), not the cap (fifty); the slack covers clock reads.
    expect(negative.expiresAt! - negative.createdAt).toBeLessThan(2 * DAY_MS);
  });

  test('a retention above the cap is clamped to it', async () => {
    const store = new ArtifactStore({ rootDir: root(), defaultRetentionMs: DAY_MS, maxRetentionMs: 2 * DAY_MS });
    const large = await store.create({ text: 'a', retentionMs: 100 * DAY_MS });
    expect(large.expiresAt! - large.createdAt).toBeGreaterThan(1.5 * DAY_MS);
    expect(large.expiresAt! - large.createdAt).toBeLessThan(2.5 * DAY_MS);
  });

  test('an explicit zero keeps the artifact until it is removed', async () => {
    const store = new ArtifactStore({ rootDir: root(), defaultRetentionMs: DAY_MS });
    expect((await store.create({ text: 'a', retentionMs: 0 })).expiresAt).toBeUndefined();
  });
});

describe('artifact metadata left without content', () => {
  async function orphan(dir: string, ageMs: number): Promise<string> {
    const store = new ArtifactStore({ rootDir: dir });
    const created = await store.create({ text: 'content' });
    const files = readdirSync(dir);
    const data = files.find((name) => name === `${created.id}.data`)!;
    const metadata = files.find((name) => name === `${created.id}.json`)!;
    rmSync(join(dir, data));
    const when = new Date(Date.now() - ageMs);
    utimesSync(join(dir, metadata), when, when);
    return metadata;
  }

  test('an aged metadata file whose content is gone is removed when the store loads', async () => {
    const dir = root();
    const metadata = await orphan(dir, 2 * DAY_MS);
    const reloaded = new ArtifactStore({ rootDir: dir });
    expect(reloaded.list()).toEqual([]);
    expect(existsSync(join(dir, metadata))).toBe(false);
  });

  test('a recent one is kept, since a writer elsewhere may still be finishing the pair', async () => {
    const dir = root();
    const metadata = await orphan(dir, 1000);
    new ArtifactStore({ rootDir: dir });
    expect(existsSync(join(dir, metadata))).toBe(true);
  });
});
