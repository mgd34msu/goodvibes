import { judgmentProcessSignal } from '../../../judgment/scripts/process-owner.ts';
// Offline editorial readings retain the actual request and response. File
// subjects locate records; equality of the saved state and questions determines
// whether those answers apply to the current input. No digest is needed.

import { isDeepStrictEqual } from 'node:util';
import type { StaticSourceCallRecord } from '../static-source-call-recording.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createSystemOnePort,
  judgmentConfigFromEnv,
  DEFAULT_MODEL,
  type Battery,
  type BatteryItems,
  type JudgmentPort,
  type YesNoReading,
  type EntryType,
  readItem,
} from '@goodvibes-jev/judgment';

/** One yes/no answer as stored: the verdict and outcome the battery's band gave, and the probability. */
export interface StoredAnswer {
  readonly verdict: 'yes' | 'no' | 'uncertain';
  readonly outcome: 'act' | 'confirm' | 'escalate';
  readonly probability: number;
}

/** The actual recorded call about one ordinary file subject. */
export interface StoredEntry {
  readonly subject: string;
  readonly record: StaticSourceCallRecord;
}

export interface StoredReadings {
  readonly format: 2;
  readonly decision: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, StoredEntry>>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Recover readings only from the actual original wire input, current battery
 * questions and requested model. Reapply the battery's real bands rather than
 * trusting saved, potentially stale derived verdicts. */
export function recordedYesNoReadings(
  record: StaticSourceCallRecord | undefined,
  battery: Battery<BatteryItems>,
  state: EntryType,
  asked: readonly string[],
  site: string,
  model: string,
): Readonly<Record<string, YesNoReading>> | undefined {
  if (!object(record) || record.format !== 1 || !object(record.call)) return undefined;
  const call = record.call;
  if (typeof call.id !== 'string' || !call.id || typeof call.at !== 'string' || !Number.isFinite(Date.parse(call.at))
    || call.battery !== battery.name || call.version !== battery.version || call.site !== site
    || call.requestedModel !== model || typeof call.observedModel !== 'string' || !call.observedModel
    || (call.requestId !== null && (typeof call.requestId !== 'string' || !call.requestId))
    || !object(call.answers) || Object.keys(call.answers).length !== asked.length) return undefined;
  const questions = Object.fromEntries(asked.map(name => [name, battery.items[name]?.question]));
  if (!isDeepStrictEqual(call.state, state) || !isDeepStrictEqual(call.questions, questions)) return undefined;
  const readings: Record<string, YesNoReading> = {};
  try {
    for (const name of asked) {
      const item = battery.items[name];
      if (!item || item.kind !== 'yes-no' || !Object.hasOwn(call.answers, name)) return undefined;
      const reading = readItem(item, call.answers[name]);
      if (reading.kind !== 'yes-no') return undefined;
      readings[name] = reading;
    }
  } catch { return undefined; }
  return readings;
}

/** `name@version`, the decision a stored file was read with. */
export function decisionId(battery: Battery<BatteryItems>): string {
  return `${battery.name}@${battery.version}`;
}

/** The requested model or alias for the battery's readings; defaults to jev-latest. */
export function readingModel(battery: Battery<BatteryItems>): string {
  return battery.model ?? DEFAULT_MODEL;
}

export function loadStoredReadings(path: string): StoredReadings | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!object(value) || value.format !== 2 || typeof value.decision !== 'string' || typeof value.model !== 'string' || !object(value.readings)) return null;
  return value as unknown as StoredReadings;
}

/**
 * The stored readings a gate may use: the file's readings when it was read
 * with this battery's decision and model, else none (every input is unread).
 */
export function currentReadings(path: string, battery: Battery<BatteryItems>): Readonly<Record<string, StoredEntry>> {
  const stored = loadStoredReadings(path);
  if (stored === null || stored.decision !== decisionId(battery) || stored.model !== readingModel(battery)) return {};
  return stored.readings;
}

/** Writes the store with one reading per line, sorted by file subject, so a diff shows exactly the readings that changed. */
export function saveStoredReadings(path: string, readings: StoredReadings): void {
  const lines = Object.entries(readings.readings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subject, entry]) => `    ${JSON.stringify(subject)}: ${JSON.stringify(entry)}`);
  const body = lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`;
  writeFileSync(path, `{\n  "format": 2,\n  "decision": ${JSON.stringify(readings.decision)},\n  "model": ${JSON.stringify(readings.model)},\n  "readings": ${body}\n}\n`, 'utf-8');
}

/** A yes/no reading as it is stored. */
export function storedAnswer(reading: YesNoReading): StoredAnswer {
  return { verdict: reading.verdict, outcome: reading.outcome, probability: Number(reading.probability.toFixed(4)) };
}

/** A settled answer: the band concluded it and code may act on it without a person confirming. */
export function isSettled(answer: StoredAnswer | undefined, verdict: 'yes' | 'no'): boolean {
  return answer !== undefined && answer.verdict === verdict && answer.outcome === 'act';
}

/** How a stored answer reads in a gate's failure text. */
export function describeAnswer(answer: StoredAnswer): string {
  return `${answer.verdict}, ${answer.outcome}, probability ${answer.probability}`;
}

/** The port a reader asks through, built from the environment (TYPESAFE_API_KEY). */
export function readerPort(): JudgmentPort {
  return createSystemOnePort(judgmentConfigFromEnv(process.env, { signal: judgmentProcessSignal() }));
}
