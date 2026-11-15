#!/usr/bin/env bun
/**
 * engine-release-gates, publish-blocking engine-pin checks.
 *
 * The workspace-dependency check and the non-npm import sweep live in the
 * shared @goodvibes-jev/engine/toolchain `engine-pin-gate` (one implementation
 * across tui/agent/webui). This file is a thin adapter that
 * drives that gate with the Agent's engine workspace dependency and the
 * authoritative monorepo lockfile, mapping results to the issue-string surface
 * that the release flow consumes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realFsReader, runEnginePinGate, type EnginePinConfig } from '@goodvibes-jev/engine/toolchain';

export const ENGINE_PACKAGE = '@goodvibes-jev/engine';

/**
 * The Agent's engine-pin shape. Kept inline (rather than read from
 * toolchain.config.json) so the pure gate stays drivable against the temp-dir
 * fixtures in engine-release-gates.test.ts, which never write a config file.
 */
export const AGENT_ENGINE_PIN: EnginePinConfig = {
  enginePackage: ENGINE_PACKAGE,
  pinSource: 'dependencies',
  lockfile: '../../bun.lock',
  sourceRoots: ['src'],
  enforceExportsMap: true,
};

/** Gate ids that concern the workspace dependency, its install and the root lock (not the import sweep). */
const PIN_AGREEMENT_GATE_IDS = new Set([
  'engine-pin-workspace',
  'engine-installed',
  'lockfile-resolves-pin',
]);

/** Read the engine pin from the same manifest group checked by the gate. */
export function readEnginePin(root: string = process.cwd()): string | undefined {
  const group = AGENT_ENGINE_PIN.pinSource;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pin = group === 'devDependencies' ? pkg.devDependencies?.[ENGINE_PACKAGE] : pkg.dependencies?.[ENGINE_PACKAGE];
  return pin;
}

/** Workspace dependency, install and root lock (the non-import gates). */
export function enginePinAgreementIssues(root: string = process.cwd()): string[] {
  return runEnginePinGate(realFsReader(root), AGENT_ENGINE_PIN)
    .filter((result) => !result.ok && PIN_AGREEMENT_GATE_IDS.has(result.id))
    .map((result) => result.detail);
}

/** Every engine release-gate issue combined, for a single call site. */
export function engineReleaseGateIssues(root: string = process.cwd()): string[] {
  return runEnginePinGate(realFsReader(root), AGENT_ENGINE_PIN)
    .filter((result) => !result.ok)
    .map((result) =>
      result.id === 'npm-specifier-only-imports'
        ? `non-npm goodvibes import found in source: ${result.detail}`
        : result.detail,
    );
}

if (import.meta.main) {
  const root = process.cwd();
  const issues = engineReleaseGateIssues(root);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`engine-release-gate: ${issue}`);
    process.exit(1);
  }
  // The shared gate checks installed manifest presence; it does not prove the
  // link target's identity or version.
  console.log('engine-release-gate: workspace dependency and root-lock checks passed, installed engine manifest present, imports use public engine exports.');
}
