import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const entrypoint = 'src/test/fixtures/compiled-html-extraction.ts';

test('the Agent resolves the lazy HTML extraction dependencies and extracts readable content in a clean process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-html-extraction-'));
  try {
    // A fresh process with an empty HOME: nothing from the developer's config or secrets can be what makes it work.
    // The run is judged on its output; the timeout only kills a hung child.
    const run = spawnSync(process.execPath, [join(root, entrypoint)], {
      cwd: dir, env: { HOME: dir }, encoding: 'utf8', timeout: 120_000,
    });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    const { result, requests } = JSON.parse(run.stdout);
    expect(result.extractorId).toBe('html-readability');
    expect(result.metadata.extractionPath).toBe('readability');
    expect(result.metadata.warnings).toBeUndefined();
    expect(result.metadata.byline).toBe('Synthetic Writer');
    expect(result.title).toBe('Compiled DOM proof');
    expect(result.structure.searchText).toContain('Parsed content & 電圧 100 V.');
    expect(result.links).toEqual(['/guide']);
    expect(requests).toEqual(['engine.knowledge.html-main-content', 'engine.knowledge.html-document-title']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
