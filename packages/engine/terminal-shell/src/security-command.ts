import { buildMcpAttackPathReview } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { ApiTokenAuditor } from '@goodvibes-jev/engine/platform/platform/security';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import type { TerminalSlashCommand } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
type AttackPathInput = Parameters<typeof buildMcpAttackPathReview>[0];
/** Security reads and presentation share a flow; each shell supplies its available views and sources. */
export function createSecurityCommand<Context extends { print(text: string): void }>(
  sources: {
    readonly tokens: (context: Context) => Pick<ApiTokenAuditor, 'auditAll'>;
    readonly security: (context: Context) => {
      readonly mcpServers: AttackPathInput['servers'];
      readonly recentMcpDecisions: AttackPathInput['recentDecisions'];
    };
    readonly policy: (
      context: Context,
    ) =>
      | { readonly lintFindings: readonly unknown[]; readonly lastPreflightReview?: { readonly status: string } | null | undefined }
      | undefined;
    readonly plugins: (context: Context) => readonly { readonly quarantined?: boolean | undefined; readonly trustTier: string }[];
    readonly subscriptions: (context: Context) => { list(): readonly unknown[]; listPending(): readonly unknown[] };
  },
  presentation: {
    readonly hidden: boolean;
    readonly beforeRead: (args: string[], context: Context) => boolean;
    readonly policyUnavailable: string;
    readonly tokenTitle: string;
    readonly separator: string;
  },
): TerminalSlashCommand<Context> {
  return {
    name: 'security',
    effect: 'read-only',
    aliases: [],
    description: 'Inspect security posture, attack paths, and review state',
    firstScreen: !presentation.hidden,
    usage: '[review | attack-paths | tokens]',
    handler(args, ctx) {
      if (presentation.beforeRead(args, ctx)) return;
      const subcommand = args[0]?.toLowerCase() ?? 'review';
      if (subcommand !== 'review' && subcommand !== 'attack-paths' && subcommand !== 'tokens') {
        throw commandRefusal(`Unknown /security subcommand: ${args[0]}\nUsage: /security [review | attack-paths | tokens]`);
      }
      // Each view reads only its own sources, so a session without policy
      // state still lists tokens and attack paths.
      if (subcommand === 'tokens') {
        const audit = sources.tokens(ctx).auditAll(Date.now());
        if (audit.results.length === 0) {
          ctx.print('No paired-device tokens to audit: no device is paired with this machine (the list follows the hourly token audit).');
          return;
        }
        ctx.print(
          [
            `${presentation.tokenTitle} (${audit.results.length})`,
            ...audit.results.map(
              (result) =>
                `  ${result.label}  policy${presentation.separator}${result.scope.policyId}  scope${presentation.separator}${result.scope.outcome}  rotation${presentation.separator}${result.rotation.outcome}  blocked${presentation.separator}${result.blocked ? 'yes' : 'no'}`,
            ),
          ].join('\n'),
        );
        return;
      }

      const securitySnapshot = sources.security(ctx);
      const attackPaths = buildMcpAttackPathReview({
        servers: securitySnapshot.mcpServers,
        recentDecisions: securitySnapshot.recentMcpDecisions,
      });
      if (subcommand === 'attack-paths') {
        if (attackPaths.findings.length === 0) {
          ctx.print('No MCP attack-path findings are currently active.');
          return;
        }
        ctx.print(
          [
            'MCP Attack-Path Review',
            `  summary: ${attackPaths.summary}`,
            ...attackPaths.findings
              .slice(0, 12)
              .map((finding) => `  ${finding.severity.toUpperCase()} ${finding.serverName}  ${finding.route}\n    ${finding.reason}`),
          ].join('\n'),
        );
        return;
      }

      const policySnapshot = sources.policy(ctx);
      if (!policySnapshot) {
        ctx.print(presentation.policyUnavailable);
        return;
      }
      const audit = sources.tokens(ctx).auditAll(Date.now());
      const plugins = sources.plugins(ctx);
      const subscriptions = sources.subscriptions(ctx);
      const builtinProviders = listBuiltinSubscriptionProviders();
      ctx.print(
        [
          'Security Review',
          `  tokens: ${audit.results.length}`,
          `  blocked tokens: ${audit.blocked.length}`,
          `  scope violations: ${audit.scopeViolations.length}`,
          `  rotation overdue: ${audit.rotationOverdue.length}`,
          `  rotation warnings: ${audit.rotationWarnings.length}`,
          `  built-in subscription providers: ${builtinProviders.length}`,
          `  active subscriptions: ${subscriptions.list().length}`,
          `  pending subscriptions: ${subscriptions.listPending().length}`,
          `  policy lint findings: ${policySnapshot.lintFindings.length}`,
          `  policy preflight: ${policySnapshot.lastPreflightReview?.status ?? 'n/a'}`,
          `  mcp servers: ${securitySnapshot.mcpServers.length}`,
          `  mcp quarantined: ${securitySnapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length}`,
          `  mcp elevated: ${securitySnapshot.mcpServers.filter((server) => server.trustMode === 'allow-all').length}`,
          `  mcp attack-path findings: ${attackPaths.findings.length}`,
          `  quarantined plugins: ${plugins.filter((plugin) => plugin.quarantined).length}`,
          `  untrusted plugins: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
        ].join('\n'),
      );
    },
  };
}
