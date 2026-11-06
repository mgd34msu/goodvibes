/** Trust evidence construction is shared; product command authority remains in its registrar. */
import { readFileSync } from 'node:fs';
export interface TrustReviewBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly permissionMode: string;
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
export interface TrustReviewSources<Context> {
  readonly listSecrets: (context: Context) => Promise<readonly string[]>;
  readonly serviceNames: (context: Context) => readonly string[];
  readonly security: (context: Context) => {
    readonly plugins: readonly { readonly trustTier: string; readonly quarantined?: boolean | undefined }[];
    readonly mcpServers: readonly { readonly trustMode: string; readonly schemaFreshness: string }[];
  };
  readonly permissionMode: (context: Context) => unknown;
  readonly serviceLabel: 'services' | 'integrations';
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
      return {
        version: 1,
        capturedAt: Date.now(),
        permissionMode: String(sources.permissionMode(ctx)),
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
      `  permission mode: ${bundle.permissionMode}`,
      `  secrets stored: ${bundle.secretKeys.length}`,
      `  configured ${sources.serviceLabel}: ${bundle.serviceNames.length}`,
      `  plugins: ${bundle.pluginSummary.total} (trusted ${bundle.pluginSummary.trusted}, limited ${bundle.pluginSummary.limited}, untrusted ${bundle.pluginSummary.untrusted}, quarantined ${bundle.pluginSummary.quarantined})`,
      `  MCP servers: ${bundle.mcpSummary.total} (constrained ${bundle.mcpSummary.constrained}, ask-on-risk ${bundle.mcpSummary.askOnRisk}, allow-all ${bundle.mcpSummary.allowAll}, blocked ${bundle.mcpSummary.blocked}, quarantined ${bundle.mcpSummary.quarantined})`,
    ].join('\n');
  }
  function inspectTrustBundle(path: string): string {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TrustReviewBundle;
    return [
      'Trust Bundle Review',
      `  captured: ${new Date(parsed.capturedAt).toISOString()}`,
      `  permission mode: ${parsed.permissionMode}`,
      `  secrets stored: ${parsed.secretKeys.length}`,
      `  configured ${sources.serviceLabel}: ${parsed.serviceNames.length}`,
      `  plugins: ${parsed.pluginSummary.total}`,
      `  MCP servers: ${parsed.mcpSummary.total}`,
    ].join('\n');
  }
  return { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle };
}
