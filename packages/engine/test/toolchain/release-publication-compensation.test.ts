import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReleaseStage } from '@goodvibes-jev/engine/toolchain/release-publication';
import { makeProjectTempDir } from '../_helpers/project-temp.ts';

test('a stage member edited right after it is linked leaves no final name behind, so a retry can publish', () => {
  const out = makeProjectTempDir('release-publication-compensation-');
  const stage = createReleaseStage(out, '.suite-staging-');
  const source = join(stage.path, 'asset.bin'), final = join(out, 'asset-final.bin');
  writeFileSync(source, 'bytes');
  const link = fs.linkSync;
  const edited = spyOn(fs, 'linkSync').mockImplementation((existing, destination) => {
    link(existing, destination);
    appendFileSync(source, 'edited after the link');
  });
  try {
    expect(() => stage.publish('asset.bin', 'asset-final.bin')).toThrow('changed during publication');
  } finally { edited.mockRestore(); }
  expect(existsSync(final)).toBe(false);
  writeFileSync(source, 'bytes');
  expect(stage.publish('asset.bin', 'asset-final.bin').path).toBe(final);
  stage.cleanup();
});
