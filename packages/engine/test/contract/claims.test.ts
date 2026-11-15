/**
 * Claim verification (contract/claims.ts): reading the report the agent
 * dictates (none is invented), the plan role that decides whether claims are
 * checked, membership in the unit's changed paths, and corroboration from the unit's own
 * baseline-scoped changed paths, every result kind.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionReport, EngineerReport } from '../../platform/src/platform/agents/completion-report.js';
import { parseUnitCompletionReport, verifyUnitClaims, type ClaimCheckInput } from '../../platform/src/platform/contract/claims.js';

function engineerReport(overrides: { filesCreated?: string[]; filesModified?: string[] }): EngineerReport {
  return {
    version: 1,
    archetype: 'engineer',
    summary: 'Done',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: ['Did the work'],
    filesCreated: overrides.filesCreated ?? [],
    filesModified: overrides.filesModified ?? [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contract-claims-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A claim check for a unit that must write, with the unit's changed paths. */
const writer = (changedPaths: readonly string[] = []): ClaimCheckInput => ({ cwd: dir, mustWrite: true, changedPaths });

describe('parseUnitCompletionReport', () => {
  test('a structured report is used as written, with the raw output kept', () => {
    const raw = ['Finished.', '```json', JSON.stringify(engineerReport({ filesCreated: ['src/a.ts'] })), '```'].join('\n');
    const parsed = parseUnitCompletionReport(raw);
    expect(parsed.report?.archetype).toBe('engineer');
    expect((parsed.report as EngineerReport).filesCreated).toEqual(['src/a.ts']);
    expect(parsed.rawOutput).toBe(raw);
  });

  test('plain output has no report: none is made up, and the raw output is kept', () => {
    expect(parseUnitCompletionReport('I changed the parser.')).toEqual({ report: null, rawOutput: 'I changed the parser.' });
    expect(parseUnitCompletionReport('')).toEqual({ report: null, rawOutput: '' });
  });
});

describe('a unit that must write', () => {
  test('no report and no changed files: unverifiable_no_claims, and the summary says the agent gave no report', () => {
    const result = verifyUnitClaims(null, writer());
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.verified).toBe(false);
    expect(result.claimedPaths).toHaveLength(0);
    expect(result.changesDetected).toBe(false);
    expect(result.summary).toContain('the agent gave no completion report');
  });

  test('no report but the unit changed files: verified_empty', () => {
    const result = verifyUnitClaims(null, writer(['src/a.ts']));
    expect(result.kind).toBe('verified_empty');
    expect(result.verified).toBe(true);
    expect(result.summary).toContain('the agent gave no completion report');
  });

  test('every claimed file is one the unit changed: files_verified', () => {
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['src/app.ts'] }), writer(['src/app.ts']));
    expect(result.kind).toBe('files_verified');
    expect(result.verified).toBe(true);
    expect(result.foundPaths).toEqual(['src/app.ts']);
  });

  test('a claimed file that exists but was not changed is not confirmed: unverified when nothing changed', () => {
    writeFileSync(join(dir, 'index.ts'), '// existing');
    const result = verifyUnitClaims(engineerReport({ filesModified: ['index.ts'] }), writer());
    expect(result.kind).toBe('unverified');
    expect(result.verified).toBe(false);
    expect(result.missingPaths).toEqual(['index.ts']);
    expect(result.summary).toContain('not changed by the unit: index.ts');
  });

  test('a claimed file is missing but the unit changed other files: git_corroborated', () => {
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['elsewhere.ts'] }), writer(['src/real.ts']));
    expect(result.kind).toBe('git_corroborated');
    expect(result.verified).toBe(true);
    expect(result.changesDetected).toBe(true);
    expect(result.summary).toContain('changed since baseline: 1 path');
  });

  test('no claims and no changed files, with a report: unverifiable_no_claims', () => {
    const result = verifyUnitClaims(engineerReport({}), writer());
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.summary).toContain('no file paths claimed');
    expect(result.summary).not.toContain('no completion report');
  });

  test('an absolute claimed path inside the tree is matched against the changed paths; one outside is unverifiable', () => {
    expect(verifyUnitClaims(engineerReport({ filesCreated: [join(dir, 'abs.ts')] }), writer(['abs.ts'])).kind).toBe('files_verified');
    const outside = verifyUnitClaims(engineerReport({ filesCreated: ['/etc/hosts', '../sibling.ts'] }), writer(['src/real.ts']));
    expect(outside.kind).toBe('git_corroborated');
    expect(outside.unverifiablePaths).toEqual(['/etc/hosts', '../sibling.ts']);
    expect(outside.foundPaths).toEqual([]);
  });

  test('the claims are the report\'s file arrays whatever its archetype', () => {
    const generic = { version: 1, archetype: 'researcher', summary: 'Done', filesCreated: ['made.ts', 'gone.ts'], filesModified: ['also-gone.ts'] } as CompletionReport;
    const result = verifyUnitClaims(generic, writer(['made.ts']));
    expect(result.claimedPaths).toEqual(['made.ts', 'gone.ts', 'also-gone.ts']);
    expect(result.foundPaths).toEqual(['made.ts']);
    expect(result.kind).toBe('git_corroborated');
    // A report with neither array claims nothing.
    expect(verifyUnitClaims({ version: 1, archetype: 'engineer', summary: 'Done' } as CompletionReport, writer()).claimedPaths).toEqual([]);
    // Entries that are not paths are not claims.
    const odd = { version: 1, archetype: 'engineer', summary: 'Done', filesCreated: ['made.ts', 7, null], filesModified: 'made.ts' } as unknown as CompletionReport;
    expect(verifyUnitClaims(odd, writer()).claimedPaths).toEqual(['made.ts']);
  });

  test('the summary names at most five missing paths and counts the rest', () => {
    const missing = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}.ts`);
    const result = verifyUnitClaims(engineerReport({ filesCreated: missing }), writer());
    expect(result.summary).toContain('not changed by the unit: a.ts, b.ts, c.ts, d.ts, e.ts (+2 more)');
  });
});

describe('a unit that must not write', () => {
  const reader = (changedPaths: readonly string[] = []): ClaimCheckInput => ({ cwd: dir, mustWrite: false, changedPaths });

  test('claims are not checked, even for an engineer-archetype report naming missing files', () => {
    const result = verifyUnitClaims(engineerReport({ filesCreated: ['ghost.ts'] }), reader());
    expect(result.kind).toBe('verified_empty');
    expect(result.verified).toBe(true);
    expect(result.claimedPaths).toEqual([]);
    expect(result.missingPaths).toEqual([]);
    expect(result.summary).toContain('Read-only unit');
  });

  test('no report is also fine', () => {
    expect(verifyUnitClaims(null, reader()).kind).toBe('verified_empty');
  });
});
