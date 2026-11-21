/** Trust evidence construction is shared; product command authority remains in its registrar. */
import { readFileSync } from 'node:fs';
import type { PermissionModeInForce } from '@goodvibes/engine/platform/platform/permissions';
export interface TrustReviewBundle {
  readonly version: 1;
  readonly capturedAt: number;
  /** The mode the conversation's gate decides calls by. */
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
export interface TrustReviewSources<Context> {
  readonly listSecrets: (context: Context) => Promise<readonly string[]>;
  readonly serviceNames: (context: Context) => readonly string[];
  readonly security: (context: Context) => {
    readonly plugins: readonly { readonly trustTier: string; readonly quarantined?: boolean | undefined }[];
    readonly mcpServers: readonly { readonly trustMode: string; readonly schemaFreshness: string }[];
  };
  /** The mode in force for this conversation, the mode chosen, and why they differ. */
  readonly permissionMode: (context: Context) => PermissionModeInForce;
  readonly serviceLabel: 'services' | 'integrations';
}
function describeMode(bundle: TrustReviewBundle): string {
  if (bundle.permissionModeChosen === undefined || bundle.permissionModeChosen === bundle.permissionMode) return bundle.permissionMode;
  return `${bundle.permissionMode} (chosen ${bundle.permissionModeChosen}${bundle.permissionModeReason ? `: ${bundle.permissionModeReason}` : ''})`;
}
function countByMode<T extends string>(values: readonly T[], mode: T): number {
  return values.filter((value) => value === mode).length;
}
export function createTrustReviewTools<Context>(sources: TrustReviewSources<Context>) {
  function buildTrustReviewBundle(ctx: Context): Promise<TrustReviewBundle> {
    return (async () => {
      const secretKeys = await sources.listSecrets(ctx);
      const services = [...sources.serviceNames(ctx)].sort((a, b) => a.localeCompare(b));
      const security = sources.security(ctx);
      const plugins = security.plugins;
      const mcpServers = security.mcpServers;
      const mode = sources.permissionMode(ctx);
      return {
        version: 1,
        capturedAt: Date.now(),
        permissionMode: mode.mode,
        ...(mode.chosen !== mode.mode ? { permissionModeChosen: mode.chosen, ...(mode.reason ? { permissionModeReason: mode.reason } : {}) } : {}),
        secretKeys,
        serviceNames: services,
        pluginSummary: {
          total: plugins.length,
          trusted: plugins.filter((plugin) => plugin.trustTier === 'trusted').length,
          limited: plugins.filter((plugin) => plugin.trustTier === 'limited').length,
          untrusted: plugins.filter((plugin) => plugin.trustTier === 'untrusted').length,
          quarantined: plugins.filter((plugin) => plugin.quarantined).length,
        },
        mcpSummary: {
          total: mcpServers.length,
          constrained: countByMode(
            mcpServers.map((server) => server.trustMode),
            'constrained',
          ),
          askOnRisk: countByMode(
            mcpServers.map((server) => server.trustMode),
            'ask-on-risk',
          ),
          allowAll: countByMode(
            mcpServers.map((server) => server.trustMode),
            'allow-all',
          ),
          blocked: countByMode(
            mcpServers.map((server) => server.trustMode),
            'blocked',
          ),
          quarantined: mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length,
        },
      };
    })();
  }
  function formatTrustReview(bundle: TrustReviewBundle): string {
    return [
      'Trust Review',
      `  permission mode: ${describeMode(bundle)}`,
      `  secrets stored: ${bundle.secretKeys.length}`,
      `  configured ${sources.serviceLabel}: ${bundle.serviceNames.length}`,
      `  plugins: ${bundle.pluginSummary.total} (trusted ${bundle.pluginSummary.trusted}, limited ${bundle.pluginSummary.limited}, untrusted ${bundle.pluginSummary.untrusted}, quarantined ${bundle.pluginSummary.quarantined})`,
      `  MCP servers: ${bundle.mcpSummary.total} (constrained ${bundle.mcpSummary.constrained}, ask-on-risk ${bundle.mcpSummary.askOnRisk}, allow-all ${bundle.mcpSummary.allowAll}, blocked ${bundle.mcpSummary.blocked}, quarantined ${bundle.mcpSummary.quarantined})`,
    ].join('\n');
  }
  function inspectTrustBundle(path: string): string {
    const parsed = readTrustBundle(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    if (!parsed) return `${path} is not a trust bundle (expected version 1 with capturedAt, permissionMode, secretKeys, serviceNames, pluginSummary and mcpSummary).`;
    return [
      'Trust Bundle Review',
      `  captured: ${new Date(parsed.capturedAt).toISOString()}`,
      `  permission mode: ${describeMode(parsed)}`,
      `  secrets stored: ${parsed.secretKeys.length}`,
      `  configured ${sources.serviceLabel}: ${parsed.serviceNames.length}`,
      `  plugins: ${parsed.pluginSummary.total}`,
      `  MCP servers: ${parsed.mcpSummary.total}`,
    ].join('\n');
  }
  return { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle };
}
