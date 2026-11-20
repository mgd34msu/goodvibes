#!/usr/bin/env bun
/**
 * engine-release-gates, the Agent's engine-pin checks with readable issue lines.
 *
 * The checks live in the shared @goodvibes/engine/toolchain `engine-pin-gate`
 * (one implementation across tui/agent/webui), and the pin shape they run with
 * is the `enginePin` section of this product's toolchain.config.json, the same
 * one the toolchain's own `engine-pin-gate` command reads. This file only maps
 * the results to issue strings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadToolchainConfig,
  realFsReader,
  resolveEnginePinConfig,
  runEnginePinGate,
  type EnginePinConfig,
} from '@goodvibes/engine/toolchain';

/** The Agent's engine-pin shape, read from `<root>/toolchain.config.json`. */
export function agentEnginePin(root: string = process.cwd()): EnginePinConfig {
  return resolveEnginePinConfig(loadToolchainConfig(root).enginePin);
}

/** Gate ids that concern the workspace dependency, its install and the root lock (not the import sweep). */
const PIN_AGREEMENT_GATE_IDS = new Set([
  'engine-pin-workspace',
  'engine-installed',
  'lockfile-resolves-pin',
]);

/** Read the engine pin from the manifest group the gate checks. */
export function readEnginePin(root: string = process.cwd()): string | undefined {
  const pin = agentEnginePin(root);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return (pin.pinSource === 'devDependencies' ? manifest.devDependencies : manifest.dependencies)?.[pin.enginePackage];
}

/** Workspace dependency, install and root lock (the non-import gates). */
export function enginePinAgreementIssues(root: string = process.cwd()): string[] {
  return runEnginePinGate(realFsReader(root), agentEnginePin(root))
    .filter((result) => !result.ok && PIN_AGREEMENT_GATE_IDS.has(result.id))
    .map((result) => result.detail);
}

/** Every engine release-gate issue combined, for a single call site. */
export function engineReleaseGateIssues(root: string = process.cwd()): string[] {
  return runEnginePinGate(realFsReader(root), agentEnginePin(root))
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
