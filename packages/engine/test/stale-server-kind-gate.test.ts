/**
 * The stale 'server' error-kind docs gate in error-contract-check.ts: each
 * checked file passes only with a stored settled-no reading of its current
 * text. Stored-reading fixtures stand in for Jev; no model is called.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileReading } from '../scripts/file-readings.ts';
import * as crypto from 'node:crypto';
import { editorialReading } from './_helpers/editorial-reading.ts';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createStaticCallRecorder, type StaticSourceCallRecord } from '../scripts/static-source-call-recording.ts';
import { staleServerKind } from '../scripts/batteries/stale-server-kind.ts';
import {
  DECISION,
  MODEL,
  staleServerKindFindings,
  staleServerKindStates,
  STALE_KIND_SITE,
  loadStaleServerKindReadings,
  type StaleServerKindReadings,
} from '../scripts/stale-server-kind-readings.ts';

const DOC = 'docs/error-kinds.md';
// The old gate flagged this through its "typed 'server' kind" shape, though it
// only says the kind was replaced.
const MIGRATION_NOTE = "## Migrating\n\nEarlier releases had a typed 'server' kind for every 5xx. It was split into 'service' and 'internal'.\n";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootWith(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-stale-kind-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, DOC), text, 'utf-8');
  mkdirSync(join(root, 'errors/src'), { recursive: true });
  writeFileSync(join(root, 'errors/src/index.ts'), "export type EngineErrorKind = 'service' | 'internal';\n");
  return root;
}

function stored(text: string, reading: FileReading, overrides: Partial<Pick<StaleServerKindReadings, 'decision' | 'model'>> = {}): StaleServerKindReadings {
  return { format: 2, decision: DECISION, model: MODEL, ...overrides, readings: { [DOC]: { windows: staleServerKindStates(DOC, text, ['service', 'internal']).map(state => editorialReading(staleServerKind, state, { stale: reading.probability }, STALE_KIND_SITE)) } } };
}

describe('stale server error-kind docs gate', () => {
  test('a migration note read as a settled no passes', () => {
    const root = rootWith(MIGRATION_NOTE);
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 }))).toEqual([]);
  });

  test('a file read as yes fails with its path', () => {
    const text = "Handle `kind: 'server'` with a retry banner.\n";
    const findings = staleServerKindFindings(rootWith(text), [DOC], stored(text, { verdict: 'yes', outcome: 'act', probability: 0.91 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${DOC} still documents stale EngineErrorKind 'server'`);
  });

  test('an uncertain reading and a no below act both fail closed', () => {
    const root = rootWith(MIGRATION_NOTE);
    for (const reading of [
      { verdict: 'uncertain', outcome: 'escalate', probability: 0.5 },
      { verdict: 'no', outcome: 'confirm', probability: 0.42 },
    ] as const) {
      const findings = staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, reading));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('no settled reading');
    }
  });

  test('a file whose text changed since its reading must be read again', () => {
    const root = rootWith(`${MIGRATION_NOTE}\nOne more line.\n`);
    const findings = staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('bun run error-kinds:read');
  });

  test('readings from another decision version or model do not count', () => {
    const root = rootWith(MIGRATION_NOTE);
    const settled = { verdict: 'no', outcome: 'act', probability: 0.04 } as const;
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, settled, { decision: 'errors.stale-server-kind@0' }))[0]).toContain('bun run error-kinds:read');
    expect(staleServerKindFindings(root, [DOC], stored(MIGRATION_NOTE, settled, { model: 'jev-0.0.1' }))[0]).toContain('bun run error-kinds:read');
    const incomplete = stored(MIGRATION_NOTE, settled);
    Reflect.deleteProperty(incomplete, 'model');
    expect(staleServerKindFindings(root, [DOC], incomplete)[0]).toContain('bun run error-kinds:read');
    expect(staleServerKindFindings(root, [DOC], null)[0]).toContain('bun run error-kinds:read');
  });
});


test('the exact original window records pass without SHA and a changed current-kind list is unread', () => {
  const root = rootWith(MIGRATION_NOTE), evidence = stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 });
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(staleServerKindFindings(root, [DOC], evidence)).toEqual([]);
    writeFileSync(join(root, 'errors/src/index.ts'), "export type EngineErrorKind = 'service' | 'internal' | 'new-kind';\n");
    expect(staleServerKindFindings(root, [DOC], evidence)[0]).toContain('bun run error-kinds:read');
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('a missing or additional window and a changed raw question are not current evidence', () => {
  const root = rootWith(MIGRATION_NOTE);
  const evidence = stored(MIGRATION_NOTE, { verdict: 'no', outcome: 'act', probability: 0.04 });
  const original = evidence.readings[DOC]!.windows[0]!;
  for (const windows of [[], [original, original], [{ ...original, call: { ...original.call, questions: {} } }]]) {
    expect(staleServerKindFindings(root, [DOC], { ...evidence, readings: { [DOC]: { windows } } })[0]).toContain('bun run error-kinds:read');
  }
});

test('old digest-only evidence cannot be paired with the current text', () => {
  const root = rootWith(MIGRATION_NOTE), path = join(root, 'old-readings.json');
  writeFileSync(path, JSON.stringify({ decision: DECISION, model: MODEL, readings: { [DOC]: { verdict: 'no', outcome: 'act', probability: 0.04 } } }));
  expect(loadStaleServerKindReadings(path)).toBeNull();
  expect(staleServerKindFindings(root, [DOC], loadStaleServerKindReadings(path))[0]).toContain('bun run error-kinds:read');
});


test('the actual error-kind battery recorder keeps the original window and raw response for offline checking', async () => {
  const root = rootWith(MIGRATION_NOTE), records: StaticSourceCallRecord[] = [];
  const fixture = fakePort(() => noulAnswer(0.04));
  const recorded = createStaticCallRecorder(fixture.port, record => { records.push(record); });
  for (const state of staleServerKindStates(DOC, MIGRATION_NOTE, ['service', 'internal'])) {
    await staleServerKind.run(recorded.port, state, { site: STALE_KIND_SITE });
  }
  expect(fixture.requests).toHaveLength(1);
  expect(records[0]?.call.state).toEqual({ path: DOC, currentKinds: ['service', 'internal'], text: '1| ## Migrating\n2| \n3| Earlier releases had a typed \'server\' kind for every 5xx. It was split into \'service\' and \'internal\'.\n4| ' });
  expect(records[0]?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  expect(staleServerKindFindings(root, [DOC], { format: 2, decision: DECISION, model: MODEL, readings: { [DOC]: { windows: records } } })).toEqual([]);
});
