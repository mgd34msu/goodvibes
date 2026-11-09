/**
 * README editorial findings retain their actual semantic answers and
 * provenance, while the required metadata check treats them as advisory.
 * These use fixture readings, so no Jev call is made. The old phrase check
 * missed reworded internal descriptions; that semantic coverage remains.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import * as storedReadings from '../scripts/ci-readings/stored-readings.ts';
import { packageReadme } from '../scripts/ci-readings/package-readme.ts';
import { evaluateReadmeReadings, readmeAdvisories, readmeProblems, readmeState } from '../scripts/ci-readings/package-readmes.ts';
import { decisionId, readingModel, stateHash, type StoredAnswer, type StoredEntry } from '../scripts/ci-readings/stored-readings.ts';

const SETTLED_YES: StoredAnswer = { verdict: 'yes', outcome: 'act', probability: 0.95 };
const SETTLED_NO: StoredAnswer = { verdict: 'no', outcome: 'act', probability: 0.06 };
const UNSETTLED: StoredAnswer = { verdict: 'uncertain', outcome: 'escalate', probability: 0.51 };

const REWORDED_INTERNAL = {
  name: '@acme/engine',
  description: 'Engine runtime',
  readme: '# @acme/engine\n\nA private building block of our monorepo that the apps share; it is only published so the apps can resolve it.\n\n`npm install @acme/engine`',
};

function stored(state: object, answers: Record<string, StoredAnswer>): Record<string, StoredEntry> {
  return { [stateHash(state)]: { answers } };
}

describe('package README readings', () => {
  test('stale wording the old phrase list never matched is reported on a settled yes', () => {
    const problems = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_YES }));
    expect(problems).toEqual(['./README.md describes the package in stale terms']);
  });

  test('a README that does not document the package is reported', () => {
    const problems = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_NO, stale: SETTLED_NO }));
    expect(problems).toEqual(['./README.md does not document the package']);
  });

  test('a documented, current README has no editorial findings', () => {
    expect(readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO }))).toEqual([]);
  });

  test('an unsettled reading is reported rather than treated as favorable', () => {
    const [problem] = readmeProblems('.', REWORDED_INTERNAL, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: UNSETTLED }));
    expect(problem).toContain('is not settled as free of stale internal or umbrella wording (uncertain, escalate, probability 0.51)');
  });

  test('a package the release does not publish is not asked about stale wording', () => {
    expect(readmeProblems('.', REWORDED_INTERNAL, false, stored(REWORDED_INTERNAL, { documents: SETTLED_YES }))).toEqual([]);
  });

  test('a changed README cannot reuse an earlier favorable reading', () => {
    const edited = { ...REWORDED_INTERNAL, readme: `${REWORDED_INTERNAL.readme}\n\nOne more line.` };
    const [problem] = readmeProblems('.', edited, true, stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO }));
    expect(problem).toContain('has no stored engine.gates.package-readme reading');
    expect(problem).toContain('bun run package-readmes:read');
  });

  test('missing evidence is reported as an advisory', () => {
    expect(readmeAdvisories('.', REWORDED_INTERNAL, true, null)[0]).toContain('missing or stale content evidence');
  });

  test.each(['decision', 'model'] as const)('a stale %s cannot reuse favorable answers', (field) => {
    const evidence = {
      decision: decisionId(packageReadme),
      model: readingModel(packageReadme),
      readings: stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO }),
      [field]: 'previous-fixture-version',
    };
    const [advisory] = readmeAdvisories('.', REWORDED_INTERNAL, true, evidence);
    expect(advisory).toContain('stale editorial evidence');
    expect(advisory).toContain(`${field} previous-fixture-version`);
    expect(advisory).toContain('bun run package-readmes:read');
  });

  test('current provenance preserves adverse and unsettled readings without reinterpretation', () => {
    const readings = stored(REWORDED_INTERNAL, { documents: SETTLED_NO, stale: UNSETTLED });
    expect(readmeAdvisories('.', REWORDED_INTERNAL, true, {
      decision: decisionId(packageReadme),
      model: readingModel(packageReadme),
      readings,
    })).toEqual(readmeProblems('.', REWORDED_INTERNAL, true, readings));
  });
});


test('one actual current README evaluation reuses its computed saved lookup for both displayed entry and findings', () => {
  const readings = stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO });
  const expected = Object.values(readings)[0];
  const original = storedReadings.stateHash;
  let computations = 0;
  const hash = spyOn(storedReadings, 'stateHash').mockImplementation(state => { computations++; return original(state); });
  try {
    const evaluation = evaluateReadmeReadings('.', REWORDED_INTERNAL, true, readings);
    expect(evaluation.entry).toBe(expected); expect(evaluation.problems).toEqual([]);
    expect(computations).toBe(1);
  } finally { hash.mockRestore(); }
});

test('a real README changed while its original reading awaited cannot inherit the old answers or throw during current evaluation', async () => {
  const root = makeProjectTempDir('readme-read-await-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/engine', description: 'A public engine' }));
  writeFileSync(join(root, 'README.md'), '# Public engine before the read\n');
  const original = readmeState(root), saved = stored(original, { documents: SETTLED_YES, stale: SETTLED_NO });
  const reading = Promise.withResolvers<Record<string, StoredEntry>>();
  const completed = reading.promise.then(readings => evaluateReadmeReadings('.', readmeState(root), true, readings));
  writeFileSync(join(root, 'README.md'), '# Different current README after admission\n');
  reading.resolve(saved);
  const current = await completed;
  expect(current.entry).toBeUndefined(); expect(current.problems).toHaveLength(1);
  expect(current.problems[0]).toContain('missing or stale content evidence');
  expect(Object.values(saved)[0]?.answers).toEqual({ documents: SETTLED_YES, stale: SETTLED_NO });
});
