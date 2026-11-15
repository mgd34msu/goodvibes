import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasReadableWebuiBundle } from '../../config/webui-bundle.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function bundle(withIndex: boolean): string {
  const dir = makeOwnedTempDir('daemon-webui-bundle'); roots.push(dir);
  if (withIndex) writeFileSync(join(dir, 'index.html'), '<html></html>'); else mkdirSync(join(dir, 'empty'));
  return dir;
}
const config = (values: Record<string, unknown>) => ({ get: (key: string): never => values[key] as never });

test('controlPlane.webui.bundleDir wins over web.staticAssetsDir, and only a readable index.html counts', () => {
  const good = bundle(true); const bad = bundle(false);
  expect(hasReadableWebuiBundle(config({ 'controlPlane.webui.bundleDir': good, 'web.staticAssetsDir': bad }))).toBe(true);
  expect(hasReadableWebuiBundle(config({ 'controlPlane.webui.bundleDir': bad, 'web.staticAssetsDir': good }))).toBe(false);
  expect(hasReadableWebuiBundle(config({ 'controlPlane.webui.bundleDir': '', 'web.staticAssetsDir': good }))).toBe(true);
  expect(hasReadableWebuiBundle(config({}))).toBe(false);
});
