/** Staging/transport regressions only. Native lifecycle proof runs on hosted accounts. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitStagedAssets, startStagedReleaseFeed } from './accept-staged-suite.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function candidate() {
  const root = mkdtempSync(join(tmpdir(), 'staged-native-delivery-')); roots.push(root);
  const lines: string[] = [];
  for (let index = 0; index < 64; index++) {
    const name = `asset-${index}.native`, bytes = `Admitted native candidate member ${index}.\n`;
    writeFileSync(join(root, name), bytes);
    // Catalog shape only. Actual native installer/updater consumers verify
    // real published/staged bodies in hosted acceptance, not this fixture.
    lines.push(`${'0'.repeat(64)}  ${name}`);
  }
  writeFileSync(join(root, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  return root;
}

test('staged catalog admission rejects ambiguous checksum entries and unlisted or linked members', async () => {
  const ambiguous = candidate(), manifest = join(ambiguous, 'SHA256SUMS.txt');
  writeFileSync(manifest, readFileSync(manifest, 'utf8') + `${'0'.repeat(64)}  asset-0.native\n`);
  await expect(admitStagedAssets(ambiguous)).rejects.toThrow('Invalid staged release checksum entry');
  const unlisted = candidate(); writeFileSync(join(unlisted, 'unadmitted.native'), 'unlisted');
  await expect(admitStagedAssets(unlisted)).rejects.toThrow();
  const linked = candidate(); rmSync(join(linked, 'asset-0.native')); symlinkSync(join(linked, 'asset-1.native'), join(linked, 'asset-0.native'));
  await expect(admitStagedAssets(linked)).rejects.toThrow('Invalid staged release file');
});

test('an admitted payload or manifest mutation retires original staged ownership', async () => {
  const root = candidate(), admitted = await admitStagedAssets(root);
  expect(admitted.entries.size).toBe(65);
  const original = readFileSync(join(root, 'asset-0.native'));
  writeFileSync(join(root, 'asset-0.native'), original);
  expect(() => admitted.assertCurrent('asset-0.native')).toThrow('changed');
  const second = candidate(), other = await admitStagedAssets(second);
  writeFileSync(join(second, 'SHA256SUMS.txt'), 'replaced manifest');
  expect(() => other.assertCurrent('SHA256SUMS.txt')).toThrow('changed');
});

test('owned loopback feed exposes the exact redirect and admitted download paths used by the real old updater', async () => {
  const root = candidate(), admitted = await admitStagedAssets(root), feed = await startStagedReleaseFeed(admitted, 'v3.1.2');
  try {
    const response = await fetch(feed.url, { method: 'HEAD', redirect: 'manual' });
    expect(response.status).toBe(302); expect(response.url).toBe(feed.url);
    expect(response.headers.get('location')).toBe('/releases/tag/v3.1.2');
    const base = feed.url.replace(/\/latest$/, '/download/v3.1.2');
    expect(await (await fetch(`${base}/asset-0.native`)).text()).toBe(readFileSync(join(root, 'asset-0.native'), 'utf8'));
    expect(await (await fetch(`${base}/SHA256SUMS.txt`)).text()).toBe(readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8'));
    feed.assertCurrent();
  } finally { await feed.close(); }
});

test('the owned feed refuses an unadmitted asset and fails the gate instead of proxying it', async () => {
  const root = candidate(), feed = await startStagedReleaseFeed(await admitStagedAssets(root), 'v3.1.2');
  try {
    const response = await fetch(feed.url.replace(/\/latest$/, '/download/v3.1.2/missing.native'));
    expect(response.status).toBe(404); expect(() => feed.assertCurrent()).toThrow('Unadmitted');
  } finally { await expect(feed.close()).rejects.toThrow('Unadmitted'); }
});

test('successful feed finish and finally cleanup join the same original drain', async () => {
  const feed = await startStagedReleaseFeed(await admitStagedAssets(candidate()), 'v3.1.2');
  const original = feed.close();
  expect(feed.close()).toBe(original);
  await original;
  expect(feed.close()).toBe(original);
  await feed.close();
  await expect(fetch(feed.url)).rejects.toThrow();
});

test('a failed feed finish retains the original failure when finally cleanup joins its drain', async () => {
  const feed = await startStagedReleaseFeed(await admitStagedAssets(candidate()), 'v3.1.2');
  await fetch(feed.url.replace(/\/latest$/, '/download/v3.1.2/unadmitted.native'));
  let originalFailure: unknown;
  try { feed.assertCurrent(); } catch (error) { originalFailure = error; }
  expect(originalFailure).toBeInstanceOf(Error);
  const original = feed.close(); expect(feed.close()).toBe(original);
  await expect(original).rejects.toBe(originalFailure);
  expect(feed.close()).toBe(original);
  await expect(feed.close()).rejects.toBe(originalFailure);
});
