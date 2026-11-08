import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalPayloadEqual } from './local-payload-comparison.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'native-local-payload-')); roots.push(root);
  const baseline = join(root, 'baseline'), selected = join(root, 'selected');
  writeFileSync(baseline, bytes); copyFileSync(baseline, selected);
  return { root, baseline, selected };
}
for (const size of [0, 1, 65_536, 65_537, 196_657]) {
  test(`direct byte comparison accepts an unchanged ${size}-byte binary without retaining it in the report`, async () => {
    const f = fixture(Buffer.alloc(size, 173));
    assert.equal(await assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'), size);
  });
}
for (const index of [0, 65_535, 65_536, 196_656]) {
  test(`same-length mutation at byte ${index} cannot pass relocation/execution comparison`, async () => {
    const f = fixture(Buffer.alloc(196_657, 173)), changed = readFileSync(f.selected);
    changed[index] = 174; writeFileSync(f.selected, changed);
    await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'), /payload bytes changed/);
  });
}
test('truncated and appended payloads are different from the original baseline', async () => {
  const f = fixture(Buffer.from('original'));
  for (const bytes of ['origina', 'original-extra']) {
    writeFileSync(f.selected, bytes);
    await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'), /payload length changed/);
  }
});
test('missing, directory and substituted symlink payloads cannot pass', async () => {
  const f = fixture(Buffer.from('original'));
  rmSync(f.selected); await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'));
  mkdirSync(f.selected); await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'));
  rmSync(f.selected, { recursive: true }); symlinkSync(f.baseline, f.selected);
  await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'));
});
test('the retained baseline must also be a real file, never a substituted symlink', async () => {
  const f = fixture(Buffer.from('original'));
  rmSync(f.baseline); symlinkSync(f.selected, f.baseline);
  await assert.rejects(assertLocalPayloadEqual(f.baseline, f.selected, 'Fixture payload'));
});
