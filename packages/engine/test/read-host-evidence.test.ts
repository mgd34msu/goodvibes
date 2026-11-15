import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTool } from '../platform/src/platform/tools/read/index.js';
import { readBodyWithHostEvidence } from '../platform/src/platform/tools/read/observation.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';

let dir: string;
let index: ProjectIndex;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-host-evidence-'));
  writeFileSync(join(dir, 'source.ts'), 'zero\nalpha\nbeta\n');
  index = new ProjectIndex(dir);
});
afterEach(async () => { await index.dispose(); rmSync(dir, { recursive: true, force: true }); });

const args = (format?: string) => ({ files: [{ path: 'source.ts', extract: 'lines', range: { start: 2, end: 3 } }], ...(format ? { output: { format } } : {}) });

test('standard read text carries no observation or resolved path; the result carries them for the host', async () => {
  const result = await new ReadTool(index).execute(args());
  const text = JSON.parse(result.output!).files[0];
  expect(text.readObservation).toBeUndefined();
  expect(text.resolvedPath).toBeUndefined();
  expect(result.hostEvidence?.reads).toEqual([{ index: 0, path: 'source.ts', resolvedPath: join(dir, 'source.ts'),
    readObservation: expect.objectContaining({ startLine: 2, completeLines: 2, truncated: false }) }]);
  const restored = readBodyWithHostEvidence(result)!.files![0] as Record<string, unknown>;
  expect(restored['readObservation']).toMatchObject({ startLine: 2, completeLines: 2 });
  expect(restored['resolvedPath']).toBe(join(dir, 'source.ts'));
});

test('verbose output keeps the fields, and a body already carrying them is returned unchanged', async () => {
  const result = await new ReadTool(index).execute(args('verbose'));
  const text = JSON.parse(result.output!).files[0];
  expect(text.readObservation).toBeDefined();
  expect(readBodyWithHostEvidence({ output: result.output })!.files![0]).toEqual(text);
  expect(readBodyWithHostEvidence(result)!.files![0]).toEqual(text);
});

test('output that is not a read body has nothing to restore', () => {
  expect(readBodyWithHostEvidence({ output: 'plain text' })).toBeUndefined();
  expect(readBodyWithHostEvidence({})).toBeUndefined();
});
