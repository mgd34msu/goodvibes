#!/usr/bin/env bun
/**
 * generate-foundation-io-entries.ts
 *
 * Rewrites the OperatorMethodInputMap / OperatorMethodOutputMap bodies in
 * contracts/src/generated/foundation-client-types.ts so EVERY operator
 * method id in contracts/src/generated/operator-method-ids.ts carries a
 * typed-IO entry rendered from its own method-catalog descriptor.
 *
 * WHY: before this script the two maps were hand-authored. 97 of 443 method ids
 * had no entry at all (they resolved to the broad `{ readonly [key: string]:
 * unknown }` / `unknown` fallbacks in OperatorMethodInput/Output, so a consumer
 * got no compile-time shape), and 91 more carried an entry that no longer
 * matched the schema it was written from, a corrected `required` array on a
 * catalog schema reached no consumer type. Both classes are structural, not
 * per-verb: rendering all 443 from the catalog is the fix.
 *
 * The rendering rules live in foundation-io-render.ts, shared with
 * check-foundation-io-types.ts, so the generator and the drift check cannot
 * disagree about what an entry should look like.
 *
 * Usage:
 *   bun run scripts/generate-foundation-io-entries.ts          # rewrite in place
 *   bun run scripts/generate-foundation-io-entries.ts --check  # exit 1 on drift
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { descriptorSchemas, parseMethodIds } from './foundation-io-catalog.ts';
import { renderType } from './foundation-io-render.ts';
import { COMPANION_CHAT_MESSAGE_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-runtime.ts';
import { RUNTIME_EVENT_DOMAINS } from '../contracts/src/generated/runtime-event-domains.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__dirname, '..');
const FOUNDATION_TYPES_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/foundation-client-types.ts');
const METHOD_IDS_PATH = resolve(ENGINE_ROOT, 'contracts/src/generated/operator-method-ids.ts');

/** Replace the body of one `export interface <name> { ... }` block. */
function replaceMapBody(fileText: string, mapName: string, body: string): string {
  const header = `export interface ${mapName} {`;
  const start = fileText.indexOf(header);
  if (start === -1) throw new Error(`${mapName} not found in foundation-client-types.ts`);
  const end = fileText.indexOf('\n}', start);
  if (end === -1) throw new Error(`${mapName} block is unterminated in foundation-client-types.ts`);
  return `${fileText.slice(0, start)}${header}\n${body}${fileText.slice(end + 1)}`;
}

/** Replace the right-hand side of one `export type <name> = ...;` line. */
function replaceNamedType(fileText: string, name: string, rendered: string): string {
  const head = `export type ${name} = `;
  const start = fileText.indexOf(head);
  if (start === -1) throw new Error(`${name} not found in foundation-client-types.ts`);
  const end = fileText.indexOf(';\n', start);
  return `${fileText.slice(0, start)}${head}${rendered}${fileText.slice(end)}`;
}

/** OperatorEventPayloadMap's `runtime.<domain>` entries, one per runtime event domain. */
function replaceRuntimeEventEntries(fileText: string): string {
  const header = 'export interface OperatorEventPayloadMap {';
  const start = fileText.indexOf(header);
  if (start === -1) throw new Error('OperatorEventPayloadMap not found in foundation-client-types.ts');
  const end = fileText.indexOf('\n}', start);
  const lines = fileText.slice(start + header.length + 1, end + 1).split('\n').filter(Boolean);
  const runtimeLine = lines.find((line) => line.startsWith('  "runtime.'));
  if (!runtimeLine) throw new Error('OperatorEventPayloadMap has no runtime entry to read the payload type from');
  const payload = runtimeLine.slice(runtimeLine.indexOf(':') + 2);
  const kept = lines.filter((line) => !line.startsWith('  "runtime.'));
  const runtime = [...RUNTIME_EVENT_DOMAINS].sort().map((domain) => `  "runtime.${domain}": ${payload}`);
  const body = [...kept, ...runtime].sort((a, b) => a.localeCompare(b));
  return `${fileText.slice(0, start)}${header}\n${body.join('\n')}\n${fileText.slice(end + 1)}`;
}

export function generateFoundationIoEntries(options: { readonly check: boolean }): boolean {
  const idsText = readFileSync(METHOD_IDS_PATH, 'utf8');
  const methodIds = parseMethodIds(idsText);

  const inputLines: string[] = [];
  const outputLines: string[] = [];
  // The maps are keyed in the generated method-id order, which
  // operator-method-ids.ts already emits sorted.
  for (const id of methodIds) {
    const { input, output } = descriptorSchemas(id);
    inputLines.push(`  "${id}": ${renderType(input)};`);
    outputLines.push(`  "${id}": ${renderType(output)};`);
  }

  const original = readFileSync(FOUNDATION_TYPES_PATH, 'utf8');
  let next = replaceMapBody(original, 'OperatorMethodInputMap', `${inputLines.join('\n')}\n`);
  next = replaceMapBody(next, 'OperatorMethodOutputMap', `${outputLines.join('\n')}\n`);
  // The named companion message type is the wire schema's own rendering, so it carries every delivery state the runtime writes.
  next = replaceNamedType(next, 'CompanionChatMessage', renderType(COMPANION_CHAT_MESSAGE_SCHEMA as unknown as Record<string, unknown>));
  // The runtime event entries are exactly the domains the runtime emits (RUNTIME_EVENT_DOMAINS); control.* entries stay as written.
  next = replaceRuntimeEventEntries(next);

  if (next === original) {
    console.log(
      `[generate-foundation-io-entries] up to date: ${methodIds.length} operator methods, ` +
        `${methodIds.length} typed input entries, ${methodIds.length} typed output entries.`,
    );
    return false;
  }

  if (options.check) {
    console.error(
      '[generate-foundation-io-entries] FAIL: OperatorMethodInputMap/OperatorMethodOutputMap, the named ' +
        'CompanionChatMessage type or the runtime event entries in contracts/src/generated/foundation-client-types.ts ' +
        'do not match the schemas and domain list they are rendered from, run `bun run scripts/generate-foundation-io-entries.ts`.',
    );
    return true;
  }

  writeFileSync(FOUNDATION_TYPES_PATH, next);
  console.log(
    `[generate-foundation-io-entries] wrote ${methodIds.length} input + ${methodIds.length} output ` +
      `entries to contracts/src/generated/foundation-client-types.ts.`,
  );
  return false;
}

if (import.meta.main) {
  const drifted = generateFoundationIoEntries({ check: process.argv.includes('--check') });
  if (drifted) process.exit(1);
}
