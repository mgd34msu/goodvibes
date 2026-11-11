import { expect, test } from 'bun:test';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { estimateTokens, LIMITS } from '@goodvibes-jev/judgment';
import { projectCheckEvidence } from '../../platform/src/platform/contract/check-evidence-projection.js';
import { judgeEvidence, judgeState, qualityState, type UnitEvidence } from '../../platform/src/platform/contract/evidence.js';

type JsonObject = { [key: string]: JsonValue };

function expandTable(value: JsonValue): JsonObject[] {
  if (Array.isArray(value)) return value as JsonObject[];
  const table = value as { shared: JsonObject; columns: string[]; rows: JsonValue[][]; pathDirectories?: string[] };
  return table.rows.map(row => {
    const fields = table.columns.slice(0, -1).map((key, index) => {
      const cell = row[index]!;
      const path = cell as [number, string];
      return [key, key === 'path' && table.pathDirectories ? table.pathDirectories[path[0]]! + path[1] : cell];
    });
    return { ...table.shared, ...Object.fromEntries(fields), ...(row[table.columns.length - 1] as JsonObject | undefined) };
  });
}

function expandPaths(value: JsonValue, files: JsonObject[]): JsonValue {
  if (Array.isArray(value)) return value;
  return (value as { ranges: [number, number][] }).ranges.flatMap(([first, last]) =>
    Array.from({ length: last - first + 1 }, (_, index) => files[first + index]!['path']!));
}

test('packed evidence round-trips every path, optional value, failure and assessment in order', () => {
  const currentFiles: JsonObject[] = Array.from({ length: 80 }, (_, index) => ({
    operation: 'read-current-file', source: 'native-host-filesystem', path: `src/${index}.ts`,
    success: index !== 9, meaning: 'The same complete native observation explanation. '.repeat(8),
    ...(index === 9 ? { error: 'Unable to establish ownership' } : { bytes: index, observationId: `observation-${index}`, binary: false }),
    ...(index === 7 ? { text: 'Complete primary text\nwith unicode λ', nullable: null } : {}),
  }));
  const files = currentFiles.map((file, index) => ({ path: file['path']!, scope: 'included', exclusionReasons: [],
    inspection: index === 7 ? 'inspected' : 'uninspected', observations: index === 7 ? [{ unitId: 'u1', ranges: ['1-2'] }] : [],
    assessment: 'unreviewed', assessments: [] }));
  const remainingFiles = [...files.map(file => file.path), files[0]!.path, files[2]!.path];
  const state = { hostOperations: [{ kind: 'owner-validation' }, ...currentFiles, { kind: 'archive-read' }],
    orchestration: { currentFiles, reviewInventory: { files, remainingFiles, versionChecksPending: [] } } };
  const before = JSON.stringify(state), projected = projectCheckEvidence(state) as JsonObject;
  const host = projected['orchestration'] as JsonObject, inventory = host['reviewInventory'] as JsonObject;
  expect(expandTable(host['currentFiles']!)).toEqual(currentFiles);
  expect(expandTable(inventory['files']!)).toEqual(files);
  expect(expandPaths(inventory['remainingFiles']!, files)).toEqual(remainingFiles);
  expect(projected['hostOperations']).toEqual([{ kind: 'owner-validation' }, expect.objectContaining({
    representation: 'same-state-reference', path: ['orchestration', 'currentFiles'] }), { kind: 'archive-read' }]);
  expect(JSON.stringify(state)).toBe(before);
  expect(JSON.stringify(projected).length).toBeLessThan(before.length / 2);
});

test('does not replace unrelated host operations or small observations with references', () => {
  const file = { operation: 'read-current-file', path: 'a.ts' };
  const state = { hostOperations: [{ ...file }], orchestration: { currentFiles: [file] } };
  expect(projectCheckEvidence(state)).toEqual(state);
});

test('both actual check states retain all 11923 review paths within long context sizing', () => {
  const files = Array.from({ length: 11923 }, (_, index) => ({
    path: `packages/example/component-${Math.floor(index / 20)}/source-file-${index}.test.ts`, scope: 'included',
    exclusionReasons: [], inspection: 'uninspected', observations: [], assessment: 'unreviewed', assessments: [],
  }));
  const inventory = { source: 'git', errors: [], totalFiles: files.length, inspectedFiles: 0, reviewedFiles: 0,
    remainingFiles: files.map(file => file.path), versionChecksPending: [], files };
  const evidence: UnitEvidence = { output: 'Complete report', diff: '', changedPaths: [], omitted: [], commands: [],
    orchestration: { currentFiles: [], reviewInventory: inventory } };
  expect((judgeEvidence(evidence) as JsonObject)['orchestration']).toBe(evidence.orchestration!);
  for (const projected of [judgeState({ goal: 'Review source' }, evidence)['evidence'], qualityState({ goal: 'Review source', brief: 'Review every assigned file.' }, evidence)]) {
    const host = (projected as JsonObject)['orchestration'] as JsonObject;
    const view = host['reviewInventory'] as JsonObject;
    expect(expandTable(view['files']!)).toEqual(files);
    expect(expandPaths(view['remainingFiles']!, files)).toEqual(inventory.remainingFiles);
    expect(estimateTokens(projected) + 5000).toBeLessThan(LIMITS.maxLongContextTokens);
  }
});
