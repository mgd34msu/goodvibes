#!/usr/bin/env bun
// read-package-readmes.ts: reads, through Jev (`engine.gates.package-readme`),
// whether each released package's README documents the package and, for a
// public package, whether it describes the package in stale internal or
// umbrella terms, and stores the actual requests and answers in
// etc/package-readme-readings.json for offline editorial advisories alongside
// the deterministic package metadata check
// (scripts/package-metadata-check.ts). Both questions ride one request per
// README. Only READMEs with no stored reading are asked; readings of text no
// longer current are dropped.
//
//   bun run package-readmes:read          (needs TYPESAFE_API_KEY)
//   bun run package-readmes:read --all    (reads every README again)

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packageReadme } from './ci-readings/package-readme.ts';
import { READINGS_PATH, README_SITE, evaluateReadmeReadings, readmeQuestions, readmeState } from './ci-readings/package-readmes.ts';
import {
  currentReadings,
  decisionId,
  readerPort,
  readingModel,
  saveStoredReadings,
  type StoredEntry,
} from './ci-readings/stored-readings.ts';
import { createStaticCallRecorder, type StaticSourceCallRecord } from './static-source-call-recording.ts';
import { packageDirs, publicPackageDirs, ENGINE_ROOT } from './release-shared.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { all: { type: 'boolean' } } });

const port = readerPort();
const records = new Map<string, StaticSourceCallRecord>();
const recorded = createStaticCallRecorder(port, entry => { records.set(entry.call.id, entry); });
const stored = values.all === true ? {} : currentReadings(READINGS_PATH, packageReadme);
const readings: Record<string, StoredEntry> = {};
let read = 0;

for (const dir of packageDirs) {
  const state = readmeState(resolve(ENGINE_ROOT, dir));
  const subject = `${dir}/README.md`;
  const asked = readmeQuestions(publicPackageDirs.includes(dir));
  const previous = evaluateReadmeReadings(dir, state, publicPackageDirs.includes(dir), stored).entry;
  if (previous !== undefined) {
    readings[subject] = previous;
    continue;
  }
  const run = await packageReadme.run(recorded.port, state, { site: README_SITE, only: asked });
  const record = run.result.decisionId ? records.get(run.result.decisionId) : undefined;
  if (!record) throw new Error('README reading did not retain its original request');
  readings[subject] = { subject, record };
  read += 1;
}

saveStoredReadings(READINGS_PATH, { format: 2, decision: decisionId(packageReadme), model: readingModel(packageReadme), readings });
console.log(`[package-readmes] ${read} read, ${packageDirs.length - read} reused, ${packageDirs.length} package README(s)`);
for (const dir of packageDirs) {
  const state = readmeState(resolve(ENGINE_ROOT, dir));
  const { answers, problems } = evaluateReadmeReadings(dir, state, publicPackageDirs.includes(dir), readings);
  const summary = answers ? Object.entries(answers)
    .map(([question, answer]) => `${question}: ${answer.verdict}, ${answer.outcome}, ${answer.probability}`).join('; ')
    : 'missing or stale readings for the current input';
  console.log(`  ${dir}/README.md  ${summary}`);
  for (const problem of problems) console.log(`    ${problem}`);
}
