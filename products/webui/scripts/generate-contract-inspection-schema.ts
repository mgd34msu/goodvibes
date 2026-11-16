#!/usr/bin/env bun
/** Snapshot the public contract schemas without shipping the full method catalog. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOperatorMethod } from '@goodvibes-jev/engine/contracts';

const GENERATED = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/generated');
export const CONTRACT_SCHEMA_PATH = resolve(GENERATED, 'contract-inspection-schema.json');
export const CONTRACT_SUMMARY_SCHEMA_PATH = resolve(GENERATED, 'contract-summary-schema.json');

function outputSchema(methodId: string): unknown {
  const schema = getOperatorMethod(methodId)?.outputSchema;
  if (!schema) throw new Error(`The engine does not expose the ${methodId} output schema.`);
  return schema;
}

/** The whole contract tree, as `contracts.get` returns it. */
export function renderContractInspectionSchema(): string {
  return `${JSON.stringify(outputSchema('contracts.get'), null, 2)}\n`;
}

/** The list (`contracts.summaries`) and the status poll (`contracts.status`). */
export function renderContractSummarySchema(): string {
  return `${JSON.stringify({ summaries: outputSchema('contracts.summaries'), status: outputSchema('contracts.status') }, null, 2)}\n`;
}

if (import.meta.main) {
  mkdirSync(GENERATED, { recursive: true });
  writeFileSync(CONTRACT_SCHEMA_PATH, renderContractInspectionSchema());
  writeFileSync(CONTRACT_SUMMARY_SCHEMA_PATH, renderContractSummarySchema());
}
