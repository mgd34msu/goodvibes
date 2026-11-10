// stale-server-kind-readings.ts
//
// The stored `errors.stale-server-kind` readings of every consumer-facing
// error doc and worker test error-contract-check.ts guards, shared by the live
// reader (read-stale-error-kinds.ts, `bun run error-kinds:read`) and the
// offline check. Saved window requests retain their actual state and questions;
// changed offered text, current error kinds or questions must be read again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_MODEL } from '@goodvibes-jev/judgment';
import type { StaticSourceCallRecord } from './static-source-call-recording.ts';
import { recordedYesNoReadings } from './ci-readings/stored-readings.ts';
import { staleServerKind, type StaleServerKindState } from './batteries/stale-server-kind.ts';
import { fileReading, isSettledNo, numberedText, windowsOf, type FileReading, type WindowSize } from './file-readings.ts';

export const ENGINE_ROOT = resolve(import.meta.dir, '..');
export const READINGS_PATH = resolve(ENGINE_ROOT, 'etc', 'stale-server-kind-readings.json');

/** The files whose text must not present 'server' as an error kind, relative to packages/engine. */
export const CHECKED_FILES: readonly string[] = [
  'docs/browser-integration.md',
  'docs/error-handling.md',
  'docs/error-kinds.md',
  'docs/expo-integration.md',
  'docs/react-native-integration.md',
  'docs/web-ui-integration.md',
  'test/workers/workers.test.ts',
  'test/workers-wrangler/wrangler.test.ts',
];

/** How much of a file one reading sees: a request buffer size. */
export const WINDOW: WindowSize = { maxLines: 200, maxChars: 8_000 };

/** The decision and model a stored set of readings must come from to count. */
export const DECISION = `${staleServerKind.name}@${staleServerKind.version}`;
export const STALE_KIND_SITE = 'errors.stale-server-kind.docs';
export const MODEL = staleServerKind.model ?? DEFAULT_MODEL;

export interface StoredStaleServerKindReading {
  readonly windows: readonly StaticSourceCallRecord[];
}

export interface StaleServerKindReadings {
  readonly format: 2;
  readonly decision: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, StoredStaleServerKindReading>>;
}

export function loadStaleServerKindReadings(path: string = READINGS_PATH): StaleServerKindReadings | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('format' in value) || value.format !== 2
    || !('decision' in value) || typeof value.decision !== 'string' || !('model' in value) || typeof value.model !== 'string'
    || !('readings' in value) || value.readings === null || typeof value.readings !== 'object' || Array.isArray(value.readings)) return null;
  return value as StaleServerKindReadings;
}

export function saveStaleServerKindReadings(readings: StaleServerKindReadings, path: string = READINGS_PATH): void {
  const sorted = Object.fromEntries(Object.entries(readings.readings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ ...readings, readings: sorted }, null, 2)}\n`, 'utf-8');
}

/** The members of the `EngineErrorKind` union in errors/src/index.ts, in declared order. */
export function currentErrorKinds(root: string = ENGINE_ROOT): string[] {
  const source = readFileSync(resolve(root, 'errors/src/index.ts'), 'utf-8');
  const union = /export\s+type\s+EngineErrorKind\s*=\s*([\s\S]*?);/.exec(source)?.[1];
  if (union === undefined) throw new Error('errors/src/index.ts must export EngineErrorKind');
  return [...union.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

/** The complete state offered for every original window, in request order. */
export function staleServerKindStates(path: string, text: string, currentKinds: string[]): StaleServerKindState[] {
  return windowsOf(text, WINDOW).map(window => ({ path, currentKinds, text: numberedText(window) }));
}

/** Reapply current bands only after every raw original request matches. */
export function currentStaleServerKindReading(
  entry: StoredStaleServerKindReading | undefined,
  path: string,
  text: string,
  currentKinds: string[],
  model = MODEL,
): FileReading | undefined {
  if (!entry || !Array.isArray(entry.windows)) return undefined;
  const states = staleServerKindStates(path, text, currentKinds);
  if (states.length !== entry.windows.length) return undefined;
  const readings = [];
  for (const [index, state] of states.entries()) {
    const original = recordedYesNoReadings(entry.windows[index], staleServerKind, state, ['stale'], STALE_KIND_SITE, model);
    if (!original?.stale) return undefined;
    readings.push(original.stale);
  }
  return fileReading(readings);
}

/** Offline findings use exact original offered inputs, never a file digest. */
export function staleServerKindFindings(
  root: string,
  files: readonly string[],
  stored: StaleServerKindReadings | null,
): string[] {
  const findings: string[] = [];
  const current = stored !== null && stored.format === 2 && stored.decision === DECISION && stored.model === MODEL;
  let kinds: string[] | undefined;
  for (const rel of files) {
    const entry = current && Object.hasOwn(stored.readings, rel) ? stored.readings[rel] : undefined;
    const reading = entry ? currentStaleServerKindReading(entry, rel, readFileSync(resolve(root, rel), 'utf-8'), kinds ??= currentErrorKinds(root)) : undefined;
    if (reading === undefined) {
      findings.push(`${rel} has no ${DECISION} reading for its current text; run \`bun run error-kinds:read\` and commit etc/stale-server-kind-readings.json`);
      continue;
    }
    if (reading.verdict === 'yes') {
      findings.push(`${rel} still documents stale EngineErrorKind 'server' (probability ${reading.probability}, ${reading.outcome})`);
    } else if (!isSettledNo(reading)) {
      findings.push(`${rel} has no settled reading on stale EngineErrorKind 'server' (${reading.verdict}, ${reading.outcome}, probability ${reading.probability}); only a settled no passes, so reword the file until it reads clearly`);
    }
  }
  return findings;
}
