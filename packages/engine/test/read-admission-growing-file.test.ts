import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentReadInputProjector } from '../platform/src/platform/tools/read/admission.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';

let dir: string;
let index: ProjectIndex;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'read-admission-')); writeFileSync(join(dir, 'app.log'), 'line 1\n'); index = new ProjectIndex(dir); });
afterEach(async () => { await index.dispose(); rmSync(dir, { recursive: true, force: true }); });

async function projected() {
  const result = await createAgentReadInputProjector(index).project({ args: { files: [{ path: 'app.log' }] }, assertCurrent: () => {} } as never);
  if (result.status !== 'projected') throw new Error('not projected');
  return result;
}

test('a file that grows between admission and the read is still the admitted file', async () => {
  const result = await projected();
  appendFileSync(join(dir, 'app.log'), 'line 2\n');
  expect(() => result.assertCurrent?.()).not.toThrow();
  await result.release?.();
});

test('a different file under the same name is not', async () => {
  const result = await projected();
  writeFileSync(join(dir, 'other.log'), 'someone else');
  renameSync(join(dir, 'other.log'), join(dir, 'app.log'));
  expect(() => result.assertCurrent?.()).toThrow();
  await result.release?.();
});
