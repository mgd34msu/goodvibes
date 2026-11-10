#!/usr/bin/env bun
import { judgmentProcessSignal } from '../../judgment/scripts/process-owner.ts';
// read-stale-error-kinds.ts: reads, through Jev (`errors.stale-server-kind`),
// whether each consumer-facing error doc and worker test error-contract-check.ts
// guards still presents 'server' as an engine error kind, and stores the readings
// in etc/stale-server-kind-readings.json for the offline check. Only files
// whose text has no stored reading are read; a long file is read in fixed
// windows, all in flight together, and reads yes when any window does.
//
//   bun run error-kinds:read          (needs TYPESAFE_API_KEY)
//   bun run error-kinds:read --all    (reads every file again)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { createStaticCallRecorder, type StaticSourceCallRecord } from './static-source-call-recording.ts';
import { staleServerKind } from './batteries/stale-server-kind.ts';
import { isSettledNo } from './file-readings.ts';
import {
  CHECKED_FILES,
  currentErrorKinds,
  currentStaleServerKindReading,
  staleServerKindStates,
  STALE_KIND_SITE,
  DECISION,
  ENGINE_ROOT,
  loadStaleServerKindReadings,
  saveStaleServerKindReadings,
  type StoredStaleServerKindReading,
} from './stale-server-kind-readings.ts';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { all: { type: 'boolean' } } });

const port = createSystemOnePort(judgmentConfigFromEnv(process.env, { signal: judgmentProcessSignal() }));
const records = new Map<string, StaticSourceCallRecord>();
const recorded = createStaticCallRecorder(port, entry => { records.set(entry.call.id, entry); });
const model = staleServerKind.model ?? port.model;
const stored = loadStaleServerKindReadings();
const reuse = values.all !== true && stored?.format === 2 && stored.decision === DECISION && stored.model === model;
const currentKinds = currentErrorKinds();

const readings: Record<string, StoredStaleServerKindReading> = {};
const toRead: { rel: string; text: string }[] = [];
for (const rel of CHECKED_FILES) {
  const text = readFileSync(resolve(ENGINE_ROOT, rel), 'utf-8');
  const previous = reuse ? stored?.readings[rel] : undefined;
  if (currentStaleServerKindReading(previous, rel, text, currentKinds, model)) readings[rel] = previous!;
  else toRead.push({ rel, text });
}

await Promise.all(toRead.map(async ({ rel, text }) => {
  const windows = await Promise.all(staleServerKindStates(rel, text, currentKinds).map(async state => {
    const run = await staleServerKind.run(recorded.port, state, { site: STALE_KIND_SITE });
    const record = run.result.decisionId ? records.get(run.result.decisionId) : undefined;
    if (!record) throw new Error('Error-kind reading did not retain its original request');
    return record;
  }));
  readings[rel] = { windows };
}));

saveStaleServerKindReadings({ format: 2, decision: DECISION, model, readings });
console.log(`[error-kinds] ${toRead.length} read, ${CHECKED_FILES.length - toRead.length} reused, ${CHECKED_FILES.length} checked files`);
const summaries = Object.entries(readings).map(([rel, entry]) => [rel, currentStaleServerKindReading(entry, rel, readFileSync(resolve(ENGINE_ROOT, rel), 'utf-8'), currentKinds, model)] as const);
const open = summaries.filter(([, reading]) => !reading || !isSettledNo(reading));
for (const [rel, reading] of open) {
  if (!reading) { console.log(`[error-kinds] ${rel}: missing or stale readings for the current input`); continue; }
  console.log(`[error-kinds] ${rel}: ${reading.verdict} (${reading.outcome}, probability ${reading.probability})`);
}
