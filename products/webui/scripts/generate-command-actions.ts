#!/usr/bin/env bun
/**
 * generate-command-actions.ts
 *
 * Snapshots the engine's slash-command actions
 * (`@goodvibes/engine/contracts/command-actions.json`, written from the
 * command descriptions by packages/engine/scripts/generate-command-actions.ts)
 * into one browser-safe module:
 *
 *   src/lib/generated/command-actions.ts
 *
 * The action sheets draw from it, so a button, its blanks, its sentence and
 * the terminal line under it are the terminal's own words. Regenerate with
 * `bun run release:prepare`; `bun run generated:check` verifies it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const TS_OUT_PATH = resolve(ROOT, 'src/lib/generated/command-actions.ts');
const ARTIFACT_PATH = resolve(ROOT, '../../packages/engine/contracts/artifacts/command-actions.json');

export function loadCommandActionsSnapshot(): unknown {
  const parsed = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
  const { $comment: _comment, ...data } = parsed;
  return data;
}

export function renderTs(snapshot: unknown): string {
  return [
    '// GENERATED FILE: DO NOT EDIT BY HAND.',
    '// Regenerate with `bun run release:prepare` (scripts/generate-command-actions.ts),',
    '// from the engine\'s contracts/artifacts/command-actions.json.',
    "import type { CommandActionsSnapshot } from '../command-actions-types';",
    '',
    `export const COMMAND_ACTIONS: CommandActionsSnapshot = ${JSON.stringify(snapshot, null, 2)};`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  mkdirSync(dirname(TS_OUT_PATH), { recursive: true });
  writeFileSync(TS_OUT_PATH, renderTs(loadCommandActionsSnapshot()));
  console.log(`Wrote ${TS_OUT_PATH}`);
}
