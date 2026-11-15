/**
 * The subpath API gate's own failure paths.
 *
 * This gate exists because `api:check` is blind to `./platform/**`: the two
 * api-extractor rollups cover 806 of the package's 6 361 subpath exports, and
 * 78 of the 140 published subpaths, `./platform/email` among them, appear in
 * neither. Measured, not assumed: changing `EmailSummary.subject` from `string`
 * to `string | null`, rebuilding and running `bunx api-extractor run --local`
 * produced no diff in `etc/goodvibes-platform.api.md` at all.
 *
 * Every assertion below drives a REJECT path and its matching ACCEPT path. A
 * detector that only ever ran against input it accepts is the failure this
 * whole file is a response to: it reports "covered" forever and nobody finds
 * out until a consumer breaks.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coverageProblems,
  diffSnapshots,
  missingFromReport,
  buildSnapshot,
  resolveSubpathEntryPoints,
  type Snapshot,
} from '../scripts/subpath-api-surface-rule.ts';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = join(ENGINE_ROOT, 'platform');

const alwaysExists = (): boolean => true;
const neverExists = (): boolean => false;

describe('resolveSubpathEntryPoints', () => {
  test('a well-formed types condition resolves and reports no problem', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': { types: './dist/platform/email/index.d.ts', import: './x.js' } } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.problems).toEqual([]);
    expect(result.entryPoints.get('./platform/email')).toBe(
      join(PACKAGE_DIR, 'dist', 'platform', 'email', 'index.d.ts'),
    );
  });

  test('a subpath with no types condition FAILS instead of being skipped', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/newthing': { import: './dist/platform/newthing/index.js' } } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.entryPoints.size).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('./platform/newthing');
    expect(result.problems[0]).toContain('no "types" condition');
  });

  test('a types path that does not exist FAILS instead of recording an empty surface', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': { types: './dist/platform/email/index.d.ts' } } },
      PACKAGE_DIR,
      neverExists,
    );
    expect(result.entryPoints.size).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('does not exist');
  });

  test('published .json assets are not treated as type entry points', () => {
    const result = resolveSubpathEntryPoints(
      {
        exports: {
          './package.json': './package.json',
          './contracts/peer-contract.json': './dist/contracts/artifacts/peer-contract.json',
        },
      },
      PACKAGE_DIR,
      neverExists,
    );
    expect(result.problems).toEqual([]);
    expect(result.entryPoints.size).toBe(0);
  });

  test('a non-object, non-asset export entry FAILS', () => {
    const result = resolveSubpathEntryPoints(
      { exports: { './platform/email': './dist/platform/email/index.js' } },
      PACKAGE_DIR,
      alwaysExists,
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('not a conditions object');
  });
});

describe('coverageProblems', () => {
  test('a subpath that exports something is accepted', () => {
    expect(coverageProblems({ './platform/email': [{ name: 'EmailSummary', kind: 'interface', text: 'x' }] })).toEqual([]);
  });

  test('a subpath that resolved to nothing is REJECTED', () => {
    const problems = coverageProblems({ './platform/email': [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exports nothing');
  });

  test('the allowlist can excuse an empty subpath, and only that subpath', () => {
    const allow = new Map([['./platform/empty', 'documented reason']]);
    expect(coverageProblems({ './platform/empty': [] }, allow)).toEqual([]);
    expect(coverageProblems({ './platform/other': [] }, allow)).toHaveLength(1);
  });
});

describe('missingFromReport', () => {
  const entries: Snapshot = { './platform/email': [{ name: 'EmailSummary', kind: 'interface', text: 'x' }] };

  test('a subpath already in the report is accepted', () => {
    expect(missingFromReport(new Map([['./platform/email', '/x.d.ts']]), entries)).toEqual([]);
  });

  test('a newly published subpath absent from the report is REJECTED', () => {
    const problems = missingFromReport(
      new Map([['./platform/email', '/x.d.ts'], ['./platform/newthing', '/y.d.ts']]),
      entries,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('./platform/newthing');
  });
});

describe('diffSnapshots', () => {
  const base: Snapshot = {
    './platform/email': [
      { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid'], text: 'interface EmailSummary { readonly subject: string; readonly uid: number; }' },
    ],
  };

  test('an unchanged surface produces no findings: the gate can answer NO', () => {
    expect(diffSnapshots(base, structuredClone(base))).toEqual([]);
  });

  test('a member TYPE change is reported, though names and required members are identical', () => {
    const after: Snapshot = {
      './platform/email': [
        { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid'], text: 'interface EmailSummary { readonly subject: string | null; readonly uid: number; }' },
      ],
    };
    const lines = diffSnapshots(base, after);
    expect(lines.some((line) => line.includes('declaration changed'))).toBe(true);
    // The name-and-required-members projection is identical across these two,
    // which is exactly why the previous version of this gate passed on it.
    expect(after['./platform/email']?.[0]?.required).toEqual(base['./platform/email']?.[0]?.required ?? []);
  });

  test('a new REQUIRED member is called out as consumer-breaking', () => {
    const after: Snapshot = {
      './platform/email': [
        { name: 'EmailSummary', kind: 'interface', required: ['subject', 'uid', 'urgent'], text: 'interface EmailSummary { readonly subject: string; readonly uid: number; readonly urgent: boolean; }' },
      ],
    };
    const lines = diffSnapshots(base, after);
    expect(lines.some((line) => line.includes('gained REQUIRED member(s): urgent'))).toBe(true);
  });

  test('an added export and a removed export are both reported', () => {
    const added = diffSnapshots(base, {
      './platform/email': [
        ...base['./platform/email'] ?? [],
        { name: 'EmailDigest', kind: 'interface', text: 'interface EmailDigest {}' },
      ],
    });
    expect(added.some((line) => line.startsWith('  + ./platform/email exports interface EmailDigest'))).toBe(true);

    const removed = diffSnapshots(base, { './platform/email': [] });
    expect(removed.some((line) => line.includes('no longer exports EmailSummary'))).toBe(true);
  });
});

describe('class members', () => {
  const base: Snapshot = {
    './platform/email': [
      {
        name: 'EmailService',
        kind: 'class',
        publicMembers: ['checkInbox', 'constructor'],
        text: 'declare class EmailService { constructor(); checkInbox(): void; }',
      },
    ],
  };

  test('an unchanged class produces no findings', () => {
    expect(diffSnapshots(base, structuredClone(base))).toEqual([]);
  });

  test('a NEW public method is named in the failure', () => {
    const after: Snapshot = {
      './platform/email': [
        {
          name: 'EmailService',
          kind: 'class',
          publicMembers: ['checkInbox', 'constructor', 'listInbox'],
          text: 'declare class EmailService { constructor(); checkInbox(): void; listInbox(): void; }',
        },
      ],
    };
    const lines = diffSnapshots(base, after);
    expect(lines.some((line) => line.includes('gained PUBLIC member(s): listInbox'))).toBe(true);
  });

  test('a removed public method is reported too', () => {
    const after: Snapshot = {
      './platform/email': [
        { name: 'EmailService', kind: 'class', publicMembers: ['constructor'], text: 'declare class EmailService { constructor(); }' },
      ],
    };
    expect(diffSnapshots(base, after).some((line) => line.includes('no longer exposes PUBLIC member(s): checkInbox'))).toBe(true);
  });


});

test('a non-exported type an export references is recorded beside it', () => {
  // Narrowing a return type through an unexported alias leaves the exported
  // declaration's text unchanged, so the snapshot has to carry the alias's
  // definition for the diff to see it.
  const root = mkdtempSync(join(tmpdir(), 'gv-api-referenced-'));
  const api = join(root, 'api.d.ts');
  const snapshotOf = (keys: string): Snapshot => {
    writeFileSync(api, `interface ReaderSnapshot { ${keys} }
      export interface Reader { getSnapshot(): ReaderSnapshot; }
      export {};`);
    const program = ts.createProgram([api], { strict: true, noEmit: true, noLib: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    return buildSnapshot(program, new Map([['./api', api]]));
  };
  try {
    const wide = snapshotOf('permissions: string; mode: string;');
    const narrow = snapshotOf('permissions: string;');
    const reader = (wide['./api'] ?? []).find((entry) => entry.name === 'Reader');
    expect(reader?.text).toContain(' ;; via ');
    expect(reader?.text).toContain('mode: string');
    expect(diffSnapshots(wide, narrow).some((line) => line.includes('declaration changed'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the API gate agrees with a real consumer across private changes and incompatible public or protected signatures', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-api-consumer-'));
  const api = join(root, 'api.d.ts'), consumer = join(root, 'consumer.ts');
  writeFileSync(consumer, `import { Counter } from './api.js';
    const count: number = new Counter().read();
    class Child extends Counter { protected verify(): number { return 1; } }
  `);
  const inspect = (privateField: string, result = 'number', protectedResult = 'number') => {
    writeFileSync(api, `interface Internal { value: ${privateField === 'cache' ? 'number' : 'string'}; }
      export declare class Counter {
        private ${privateField}: Internal;
        protected verify(): ${protectedResult};
        read(): ${result};
      }
      export {};`);
    const program = ts.createProgram([api, consumer], { strict: true, noEmit: true, noLib: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    const input = program.getSourceFile(consumer);
    if (!input) throw new Error('Consumer did not load');
    return { snapshot: buildSnapshot(program, new Map([['./api', api]])), errors: program.getSemanticDiagnostics(input) };
  };
  try {
    const original = inspect('cache');
    expect(original.errors).toEqual([]);
    const privateChange = inspect('nextCache');
    expect(privateChange.errors).toEqual([]);
    expect(diffSnapshots(original.snapshot, privateChange.snapshot)).toEqual([]);
    for (const incompatible of [inspect('nextCache', 'string'), inspect('nextCache', 'number', 'string')]) {
      expect(incompatible.errors.length).toBeGreaterThan(0);
      expect(diffSnapshots(original.snapshot, incompatible.snapshot).length).toBeGreaterThan(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
