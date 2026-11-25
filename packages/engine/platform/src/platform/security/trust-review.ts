/**
 * The trust summary: the permission mode, the secrets and services set up, and how far each plugin and MCP server
 * is trusted, as one record ("See what is trusted", saved to a file and read back by "Read a saved trust summary").
 * Built by the daemon, which holds these (capabilities/builtin/security-review.ts); secret names only, never a value.
 */
import { readFileSync } from 'node:fs';
import type { PermissionModeInForce } from '../permissions/decision-model-readiness.js';

export interface TrustReviewBundle {
  readonly version: 1;
  readonly capturedAt: number;
  /** The mode the gate decides calls by. */
  readonly permissionMode: string;
  /** The mode chosen, present only when it differs from the mode in force. */
  readonly permissionModeChosen?: string;
  /** Why the chosen mode is not the mode in force, present with `permissionModeChosen`. */
  readonly permissionModeReason?: string;
  readonly secretKeys: readonly string[];
  readonly serviceNames: readonly string[];
  readonly pluginSummary: {
    readonly total: number;
    readonly trusted: number;
    readonly limited: number;
    readonly untrusted: number;
    readonly quarantined: number;
  };
  readonly mcpSummary: {
    readonly total: number;
    readonly constrained: number;
    readonly askOnRisk: number;
    readonly allowAll: number;
    readonly blocked: number;
    readonly quarantined: number;
  };
}

/** What the summary is read from. */
export interface TrustReviewFacts {
  readonly secretKeys: readonly string[];
  readonly serviceNames: readonly string[];
  readonly plugins: readonly { readonly trustTier: string; readonly quarantined?: boolean | undefined }[];
  readonly mcpServers: readonly { readonly trustMode: string; readonly schemaFreshness: string }[];
  /** The mode in force, the mode chosen, and why they differ. */
  readonly permissionMode: PermissionModeInForce;
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function readTrustBundle(value: unknown): TrustReviewBundle | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  const summary = (entry: unknown): boolean => !!entry && typeof entry === 'object' && isCount((entry as { total?: unknown }).total);
  if (b['version'] !== 1 || !isCount(b['capturedAt']) || Number.isNaN(new Date(b['capturedAt'] as number).getTime())) return null;
  if (typeof b['permissionMode'] !== 'string' || !Array.isArray(b['secretKeys']) || !Array.isArray(b['serviceNames'])) return null;
  if (!summary(b['pluginSummary']) || !summary(b['mcpSummary'])) return null;
  if (b['permissionModeChosen'] !== undefined && typeof b['permissionModeChosen'] !== 'string') return null;
  if (b['permissionModeReason'] !== undefined && typeof b['permissionModeReason'] !== 'string') return null;
  return value as TrustReviewBundle;
}

function describeMode(bundle: TrustReviewBundle): string {
  if (bundle.permissionModeChosen === undefined || bundle.permissionModeChosen === bundle.permissionMode) return bundle.permissionMode;
  return `${bundle.permissionMode} (chosen ${bundle.permissionModeChosen}${bundle.permissionModeReason ? `: ${bundle.permissionModeReason}` : ''})`;
}

function countByMode(values: readonly string[], mode: string): number {
  return values.filter((value) => value === mode).length;
}

/** The summary as a record, from what the daemon holds now. */
export function buildTrustReviewBundle(facts: TrustReviewFacts): TrustReviewBundle {
  const modes = facts.mcpServers.map((server) => server.trustMode);
  const mode = facts.permissionMode;
  return {
    version: 1,
    capturedAt: Date.now(),
    permissionMode: mode.mode,
    ...(mode.chosen !== mode.mode ? { permissionModeChosen: mode.chosen, ...(mode.reason ? { permissionModeReason: mode.reason } : {}) } : {}),
    secretKeys: [...facts.secretKeys],
    serviceNames: [...facts.serviceNames].sort((a, b) => a.localeCompare(b)),
    pluginSummary: {
      total: facts.plugins.length,
      trusted: facts.plugins.filter((plugin) => plugin.trustTier === 'trusted').length,
      limited: facts.plugins.filter((plugin) => plugin.trustTier === 'limited').length,
      untrusted: facts.plugins.filter((plugin) => plugin.trustTier === 'untrusted').length,
      quarantined: facts.plugins.filter((plugin) => plugin.quarantined).length,
    },
    mcpSummary: {
      total: facts.mcpServers.length,
      constrained: countByMode(modes, 'constrained'),
      askOnRisk: countByMode(modes, 'ask-on-risk'),
      allowAll: countByMode(modes, 'allow-all'),
      blocked: countByMode(modes, 'blocked'),
      quarantined: facts.mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length,
    },
  };
}

/** The summary in lines, as "See what is trusted" says it. */
export function formatTrustReview(bundle: TrustReviewBundle): string {
  return [
    'What is trusted',
    `  permission mode: ${describeMode(bundle)}`,
    `  secrets stored: ${bundle.secretKeys.length}`,
    `  services set up: ${bundle.serviceNames.length}`,
    `  plugins: ${bundle.pluginSummary.total} (trusted ${bundle.pluginSummary.trusted}, limited ${bundle.pluginSummary.limited}, untrusted ${bundle.pluginSummary.untrusted}, quarantined ${bundle.pluginSummary.quarantined})`,
    `  MCP servers: ${bundle.mcpSummary.total} (constrained ${bundle.mcpSummary.constrained}, ask-on-risk ${bundle.mcpSummary.askOnRisk}, allow-all ${bundle.mcpSummary.allowAll}, blocked ${bundle.mcpSummary.blocked}, quarantined ${bundle.mcpSummary.quarantined})`,
  ].join('\n');
}

/** A saved summary read back, in lines; a file that is not one says so. Throws when the file cannot be read. */
export function inspectTrustBundle(path: string): string {
  const parsed = readTrustBundle(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
  if (!parsed) return `${path} is not a trust summary (expected version 1 with capturedAt, permissionMode, secretKeys, serviceNames, pluginSummary and mcpSummary).`;
  return [
    'Saved trust summary',
    `  captured: ${new Date(parsed.capturedAt).toISOString()}`,
    `  permission mode: ${describeMode(parsed)}`,
    `  secrets stored: ${parsed.secretKeys.length}`,
    `  services set up: ${parsed.serviceNames.length}`,
    `  plugins: ${parsed.pluginSummary.total}`,
    `  MCP servers: ${parsed.mcpSummary.total}`,
  ].join('\n');
}
