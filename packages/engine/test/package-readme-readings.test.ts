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
import * as crypto from 'node:crypto';
import { editorialReading } from './_helpers/editorial-reading.ts';
import { createStaticCallRecorder, type StaticSourceCallRecord } from '../scripts/static-source-call-recording.ts';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { packageReadme } from '../scripts/ci-readings/package-readme.ts';
import { README_SITE, evaluateReadmeReadings, readmeAdvisories, readmeProblems, readmeState } from '../scripts/ci-readings/package-readmes.ts';
import { decisionId, readingModel, type StoredAnswer, type StoredEntry } from '../scripts/ci-readings/stored-readings.ts';

const SETTLED_YES: StoredAnswer = { verdict: 'yes', outcome: 'act', probability: 0.95 };
const SETTLED_NO: StoredAnswer = { verdict: 'no', outcome: 'act', probability: 0.06 };
const UNSETTLED: StoredAnswer = { verdict: 'uncertain', outcome: 'escalate', probability: 0.51 };

const REWORDED_INTERNAL = {
  name: '@acme/engine',
  description: 'Engine runtime',
  readme: '# @acme/engine\n\nA private building block of our monorepo that the apps share; it is only published so the apps can resolve it.\n\n`npm install @acme/engine`',
};

function stored(state: typeof REWORDED_INTERNAL, answers: Record<string, StoredAnswer>): Record<string, StoredEntry> {
  const subject = './README.md';
  return { [subject]: { subject, record: editorialReading(packageReadme, state,
    Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.probability])), README_SITE) } };
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
      format: 2 as const,
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

  test('current provenance preserves adverse and unsettled raw answers', () => {
    const readings = stored(REWORDED_INTERNAL, { documents: SETTLED_NO, stale: UNSETTLED });
    expect(readmeAdvisories('.', REWORDED_INTERNAL, true, {
      format: 2 as const,
      decision: decisionId(packageReadme),
      model: readingModel(packageReadme),
      readings,
    })).toEqual(readmeProblems('.', REWORDED_INTERNAL, true, readings));
  });
});


test('an exact saved README request supplies both displayed answers and findings without hashing', () => {
  const readings = stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO });
  const expected = Object.values(readings)[0];
  const hash = spyOn(crypto, 'createHash');
  try {
    const evaluation = evaluateReadmeReadings('.', REWORDED_INTERNAL, true, readings);
    expect(evaluation.entry).toBe(expected); expect(evaluation.problems).toEqual([]);
    expect(evaluation.answers).toEqual({ documents: SETTLED_YES, stale: SETTLED_NO });
    expect(hash).not.toHaveBeenCalled();
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
  expect(Object.values(saved)[0]?.record.call.state).toEqual(original);
});

test('an empty saved README store reports identical missing evidence with no SHA execution', () => {
  const hash = spyOn(crypto, 'createHash');
  try {
    const evaluation = evaluateReadmeReadings('.', REWORDED_INTERNAL, true, {});
    expect(evaluation.entry).toBeUndefined();
    expect(evaluation.problems).toEqual(['./README.md has no stored engine.gates.package-readme reading for its current text (missing or stale content evidence); run `bun run package-readmes:read` and commit packages/engine/etc/package-readme-readings.json']);
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('the actual reader recorder retains raw input, questions, answer, model and usage for offline reuse', async () => {
  const fixture = fakePort(name => noulAnswer(name === 'documents' ? 0.95 : 0.06));
  let record: StaticSourceCallRecord | undefined;
  const captured = createStaticCallRecorder(fixture.port, original => { record = original; });
  await packageReadme.run(captured.port, REWORDED_INTERNAL, { site: README_SITE });
  expect(record?.call.state).toEqual(REWORDED_INTERNAL);
  expect(record?.call.questions).toEqual(Object.fromEntries(Object.entries(packageReadme.items).map(([name, item]) => [name, item.question])));
  expect(record?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  expect(record?.call.requestedModel).toBe(fixture.port.model);
  expect(record?.call.observedModel).toBe('jev-1.13.0');
  if (!record) throw new Error('Expected actual synthetic request record');
  const evidence = { './README.md': { subject: './README.md', record } };
  expect(readmeProblems('.', REWORDED_INTERNAL, true, evidence)).toEqual([]);
  expect(readmeProblems('.', { ...REWORDED_INTERNAL, description: 'Changed package purpose' }, true, evidence)[0]).toContain('missing or stale');
});

test.each(['state', 'questions', 'battery', 'version', 'site', 'requestedModel', 'observedModel', 'answers'] as const)('a changed or malformed raw %s cannot lend favorable answers', field => {
  const evidence = stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO });
  const call = evidence['./README.md']!.record.call;
  Reflect.set(call, field, field === 'observedModel' ? '' : field === 'version' ? 0 : field === 'state' || field === 'questions' || field === 'answers' ? {} : 'wrong-unit-fixture');
  expect(readmeProblems('.', REWORDED_INTERNAL, true, evidence)[0]).toContain('missing or stale');
});

test('a copied favorable call stored under another subject is not a reading of this file', () => {
  const evidence = stored(REWORDED_INTERNAL, { documents: SETTLED_YES, stale: SETTLED_NO });
  const entry = evidence['./README.md']!;
  expect(readmeProblems('.', REWORDED_INTERNAL, true, { './README.md': { ...entry, subject: 'other/README.md' } })[0]).toContain('missing or stale');
});
