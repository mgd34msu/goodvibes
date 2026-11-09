#!/usr/bin/env bun
/**
 * engine-release-gates, publish-blocking engine-pin checks.
 *
 * The pin/lock/installed tri-agreement, overlay-marker hard-fail, and non-npm
 * import sweep now live in the shared @goodvibes-jev/engine/toolchain `engine-pin-gate`
 * (one implementation across tui/agent/webui). This file is a thin adapter that
 * drives that gate with the Agent's engine workspace dependency and the
 * authoritative monorepo lockfile, mapping results to the issue-string surface
 * that publish-check and `engine:gate` already consume.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realFsReader, runEnginePinGate, type EnginePinConfig } from '@goodvibes-jev/engine/toolchain';

export const ENGINE_PACKAGE = '@goodvibes-jev/engine';
export const OVERLAY_MARKER_REL = 'node_modules/@goodvibes-jev/engine/.local-engine-overlay.json';

/**
 * The Agent's engine-pin shape. Kept inline (rather than read from
 * toolchain.config.json) so the pure gate stays drivable against the temp-dir
 * fixtures in engine-release-gates.test.ts, which never write a config file.
 */
export const AGENT_ENGINE_PIN: EnginePinConfig = {
  enginePackage: ENGINE_PACKAGE,
  pinSource: 'dependencies',
  lockfile: '../../bun.lock',
  overlayMarker: OVERLAY_MARKER_REL,
  sourceRoots: ['src'],
  enforceExportsMap: true,
};

/** Gate ids that concern pin ⇄ lockfile ⇄ installed agreement (not the import sweep). */
const PIN_AGREEMENT_GATE_IDS = new Set([
  'local-engine-overlay-absent',
  'engine-pin-exact-semver',
  'installed-matches-pin',
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

/** Overlay-marker + exact-pin + pin/lock/installed agreement (the non-import gates). */
export function enginePinAgreementIssues(root: string = process.cwd()): string[] {
  return runEnginePinGate(realFsReader(root), AGENT_ENGINE_PIN)
    .filter((result) => !result.ok && PIN_AGREEMENT_GATE_IDS.has(result.id))
    .map((result) => result.detail);
}

/** Every engine release-gate issue combined, for a single publish-check call site. */
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
  // For workspace pins, the shared gate checks installed manifest presence;
  // it does not prove the link target's identity or version.
  console.log('engine-release-gate: dependency and root-lock checks passed, installed engine manifest present, overlay absent, imports use public engine exports.');
}
