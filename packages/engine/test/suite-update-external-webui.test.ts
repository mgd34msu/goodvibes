import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { applySuiteUpdate, installedSuiteNeedsRepair } from '../platform/src/platform/runtime/suite-update.js';
import { suiteReleaseFixture } from './_helpers/suite-release-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a separately managed WebUI is not reported as a repair the update can never make', async () => {
  const f = suiteReleaseFixture(); roots.push(f.root);
  await applySuiteUpdate(f.options);
  expect(installedSuiteNeedsRepair(f.options)).toBe(false);
  const external = { ...f.options, webuiDirectory: '/srv/webui' };
  expect(installedSuiteNeedsRepair(external)).toBe(false);
  await expect(applySuiteUpdate(external)).rejects.toThrow('controlPlane.webui.bundleDir');
});

test('a separately managed WebUI does not hide a genuinely broken product install', () => {
  const f = suiteReleaseFixture(); roots.push(f.root);
  expect(installedSuiteNeedsRepair({ ...f.options, webuiDirectory: '/srv/webui' })).toBe(true);
});
