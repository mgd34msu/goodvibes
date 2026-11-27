import { type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { captureCatalogReadRequest, selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { captureStatefulCatalogRequest, rankStatefulCatalog } from './agent-harness-stateful-catalog-source.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { listBuiltinSubscriptionProviders } from '@goodvibes/engine/platform/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';

export interface AgentHarnessSecurityArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly findingId?: unknown;
  readonly bundlePath?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type SecurityFindingSeverity = 'info' | 'warn' | 'blocker';
type SecurityFindingSource = 'token' | 'policy' | 'mcp' | 'plugin' | 'incident';

interface SecurityFinding {
  readonly findingId: string;
  readonly source: SecurityFindingSource;
  readonly severity: SecurityFindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
  readonly route: string;
}

interface SupportBundleRoute {
  readonly bundleType: 'support' | 'auth' | 'trust' | 'subscription' | 'voice';
  readonly defaultPath: string;
  readonly inspectCommand: string;
  readonly exportCommand: string;
  readonly importCommand?: string;
}

type SecurityFindingResolution =
  | { readonly status: 'found'; readonly finding: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type SupportBundleResolution =
  | { readonly status: 'found'; readonly bundle: Record<string, unknown> }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const SUPPORT_BUNDLE_ROUTES: readonly SupportBundleRoute[] = [
  {
    bundleType: 'support',
    defaultPath: 'goodvibes-agent-bundle.json',
    // The support bundle is the daemon's: run by capability_run (System, Support and transfer, for a person).
    inspectCommand: 'capability_run id:"bundle.inspect" inputs:{"path"}',
    exportCommand: 'capability_run id:"bundle.export" inputs:{"path"}',
    importCommand: 'capability_run id:"bundle.import" inputs:{"path"} (loading security settings too is put to the owner)',  },
  {
    bundleType: 'auth',
    defaultPath: 'auth-review-bundle.json',
    inspectCommand: 'capability_run id:"auth.inspect" inputs:{"path"}',
    exportCommand: 'capability_run id:"auth.export" inputs:{"path"}',  },
  {
    bundleType: 'trust',
    defaultPath: 'trust-review-bundle.json',
    inspectCommand: 'capability_run security.read-trust with inputs.path',
    exportCommand: 'capability_run security.save-trust with inputs.path',  },
  {
    bundleType: 'subscription',
    defaultPath: 'subscription-bundle.json',
    inspectCommand: 'capability_run id:"provider.inspect" inputs:{"path"}',
    exportCommand: 'capability_run id:"provider.export" inputs:{"path"} (the owner\'s own act)',  },
  {
    bundleType: 'voice',
    defaultPath: 'voice-bundle.json',
    inspectCommand: 'capability_run id:"voice.inspect" inputs:{"path"}',
    exportCommand: 'capability_run id:"voice.export" inputs:{"path"}',  },
];

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNestedValue(source: unknown, path: string): unknown {
  let cursor = source;
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function countNestedLeaves(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countNestedLeaves(entry), 0);
  if (typeof value === 'object') return Object.values(value).reduce((total, entry) => total + countNestedLeaves(entry), 0);
  return 1;
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

/** A short stable key for text that tells two findings of one rule or server apart (FNV-1a, base 36). */
function textKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

function safeText(value: unknown, fallback = 'n/a'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

const UNTRUSTED_TEXT_LIMIT = 240;

// Text an MCP server supplied about itself is shown bounded and labelled, so it cannot read as a trusted instruction.
function untrustedText(value: unknown, fallback = 'n/a'): string {
  return previewHarnessText(safeText(value, fallback), UNTRUSTED_TEXT_LIMIT);
}

function slashArgument(value: string): string {
  return /^[A-Za-z0-9._:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function severityRank(severity: SecurityFindingSeverity): number {
  if (severity === 'blocker') return 0;
  if (severity === 'warn') return 1;
  return 2;
}



function securityFindingModelRoute(): string {
  return 'security action:"finding" or screens_keys_commands action:"run_command"';
}

function supportBundleModelRoute(): string {
  return 'support action:"bundle" or capability_find need:"support bundle"';
}

function describeFinding(finding: SecurityFinding, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    source: finding.source,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    route: finding.route,
    modelRoute: securityFindingModelRoute(),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters && finding.detail ? { detail: finding.detail } : {}),
    ...(includeParameters ? {
      policy: {
        effect: 'read-only',
        values: 'Security posture returns counts, labels, policy ids, route names, and redacted bundle summaries only; token values, secret values, and raw config values are never returned.',
        mutation: 'Token rotation, policy changes, MCP trust changes, bundle export/import, auth repair, and voice enable/disable stay explicit confirmation-gated workspace or slash-command flows.',
      },
    } : {}),
  };
}

function buildTokenFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const audit = isRecord(securitySnapshot?.audit) ? securitySnapshot.audit : null;
  const results = readRecordArray(audit?.results);
  return results
    .map((result): SecurityFinding | null => {
      const scope = isRecord(result.scope) ? result.scope : {};
      const rotation = isRecord(result.rotation) ? result.rotation : {};
      const label = safeText(result.label, '');
      const scopeOutcome = safeText(scope.outcome);
      const rotationOutcome = safeText(rotation.outcome);
      const blocked = result.blocked === true;
      if (!blocked && scopeOutcome === 'ok' && rotationOutcome === 'ok') return null;
      const severity: SecurityFindingSeverity = blocked || rotationOutcome === 'overdue' ? 'blocker' : 'warn';
      return {
        findingId: label ? `token-${slug(label)}` : `token-${textKey(`${safeText(scope.policyId)}|${scopeOutcome}|${rotationOutcome}`)}`,
        source: 'token',
        severity,
        title: `Token ${label || 'without a label'}`,
        summary: `Scope ${scopeOutcome}; rotation ${rotationOutcome}; blocked ${blocked ? 'yes' : 'no'}.`,
        route: 'capability_run security.tokens (Permissions and safety, Device tokens)',
        detail: {
          tokenLabel: label || 'n/a',
          policyId: safeText(scope.policyId),
          scopeOutcome,
          rotationOutcome,
          blocked,
          ...(typeof rotation.dueAt === 'number' ? { dueAt: new Date(rotation.dueAt).toISOString() } : {}),
        },
      };
    })
    .filter((finding): finding is SecurityFinding => finding !== null);
}

function buildPolicyFindings(policySnapshot: unknown): readonly SecurityFinding[] {
  if (!isRecord(policySnapshot)) return [];
  const lintFindings = readRecordArray(policySnapshot.lintFindings);
  const findings = lintFindings.map((finding): SecurityFinding => {
    const level = safeText(finding.level ?? finding.severity, 'warn').toLowerCase();
    const severity: SecurityFindingSeverity = level === 'error' || level === 'blocker' ? 'blocker' : level === 'info' ? 'info' : 'warn';
    const rule = safeText(finding.ruleId ?? finding.rule ?? finding.code, '');
    const message = safeText(finding.message ?? finding.summary ?? finding.reason, 'Policy lint finding');
    return {
      findingId: `policy-${rule ? `${slug(rule)}-` : ''}${textKey(message)}`,
      source: 'policy',
      severity,
      title: `Policy ${rule || 'lint'}`,
      summary: message,
      route: 'capability_run security.review (Permissions and safety, This conversation)',
      detail: {
        rule,
        message,
        level,
      },
    };
  });
  const preflight = isRecord(policySnapshot.lastPreflightReview) ? policySnapshot.lastPreflightReview : null;
  if (!preflight || safeText(preflight.status, 'ok') === 'ok') return findings;
  return [
    ...findings,
    {
      findingId: 'policy-preflight',
      source: 'policy',
      severity: safeText(preflight.status) === 'blocked' ? 'blocker' : 'warn',
      title: 'Policy preflight',
      summary: `Preflight ${safeText(preflight.status)} with ${safeText(preflight.issueCount, '0')} issue(s).`,
      route: 'capability_run security.review (Permissions and safety, This conversation)',
      detail: {
        status: safeText(preflight.status),
        issueCount: typeof preflight.issueCount === 'number' ? preflight.issueCount : 0,
      },
    },
  ];
}

function mcpAttackPathFindings(securitySnapshot: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  if (isRecord(securitySnapshot?.attackPathReview)) return readRecordArray(securitySnapshot.attackPathReview.findings);
  // The snapshot is untyped read-model data; the review builder reads only the fields it needs from each entry.
  type ReviewInput = Parameters<typeof buildMcpAttackPathReview>[0];
  const review = buildMcpAttackPathReview({
    servers: readRecordArray(securitySnapshot?.mcpServers) as unknown as ReviewInput['servers'],
    recentDecisions: readArray(securitySnapshot?.recentMcpDecisions) as unknown as ReviewInput['recentDecisions'],
  });
  return readRecordArray(review.findings);
}

function buildMcpFindings(securitySnapshot: Record<string, unknown> | null, attackPathFindings = mcpAttackPathFindings(securitySnapshot)): readonly SecurityFinding[] {
  const mcpServers = readRecordArray(securitySnapshot?.mcpServers);
  const attackFindings = attackPathFindings.map((finding): SecurityFinding => {
    const serverName = safeText(finding.serverName, 'unnamed-server');
    const severityRaw = safeText(finding.severity, 'warn').toLowerCase();
    const severity: SecurityFindingSeverity = severityRaw === 'critical' || severityRaw === 'high' || severityRaw === 'blocker' ? 'blocker' : severityRaw === 'info' ? 'info' : 'warn';
    return {
      findingId: `mcp-attack-${slug(serverName)}-${textKey(`${safeText(finding.route)}|${safeText(finding.reason)}`)}`,
      source: 'mcp',
      severity,
      title: `MCP attack path ${serverName}`,
      summary: untrustedText(finding.reason, 'MCP attack-path finding'),
      route: 'capability_run security.attack-paths (Permissions and safety, This conversation)',
      detail: {
        serverName,
        route: untrustedText(finding.route),
        reason: untrustedText(finding.reason),
        untrustedFields: ['serverName', 'route', 'reason'],
        severity: severityRaw,
      },
    };
  });
  const postureFindings = mcpServers.flatMap((server, index): readonly SecurityFinding[] => {
    const serverName = safeText(server.name, `server-${index + 1}`);
    const findings: SecurityFinding[] = [];
    if (server.schemaFreshness === 'quarantined') {
      findings.push({
        findingId: `mcp-quarantined-${slug(serverName)}`,
        source: 'mcp',
        severity: 'blocker',
        title: `MCP quarantined ${serverName}`,
        summary: `Server schema is quarantined. Reason reported by the server (unverified text): ${untrustedText(server.quarantineReason, 'none given')}`,
        route: `/mcp repair ${slashArgument(serverName)}`,
        detail: {
          serverName,
          trustMode: safeText(server.trustMode),
          role: safeText(server.role),
          quarantineReason: untrustedText(server.quarantineReason),
          quarantineDetail: untrustedText(server.quarantineDetail),
          untrustedFields: ['serverName', 'quarantineReason', 'quarantineDetail'],
        },
      });
    }
    if (server.trustMode === 'allow-all') {
      findings.push({
        findingId: `mcp-allow-all-${slug(serverName)}`,
        source: 'mcp',
        severity: 'warn',
        title: `MCP elevated trust ${serverName}`,
        summary: 'Server is configured with allow-all trust.',
        route: `/mcp review ${slashArgument(serverName)}`,
        detail: {
          serverName,
          trustMode: 'allow-all',
          role: safeText(server.role),
        },
      });
    }
    return findings;
  });
  return [...attackFindings, ...postureFindings];
}

function buildPluginFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const plugins = readRecordArray(securitySnapshot?.plugins);
  return plugins
    .filter((plugin) => plugin.quarantined === true || plugin.trustTier === 'untrusted')
    .map((plugin, index): SecurityFinding => {
      const name = safeText(plugin.name, `plugin-${index + 1}`);
      const quarantined = plugin.quarantined === true;
      return {
        findingId: `plugin-${quarantined ? 'quarantined' : 'untrusted'}-${slug(name)}`,
        source: 'plugin',
        severity: quarantined ? 'blocker' : 'warn',
        title: `Plugin ${name}`,
        summary: quarantined ? 'Plugin is quarantined.' : 'Plugin is untrusted.',
        route: 'capability_run security.trust (Permissions and safety, Policy)',
        detail: {
          name,
          version: safeText(plugin.version),
          enabled: plugin.enabled === true,
          active: plugin.active === true,
          trustTier: safeText(plugin.trustTier),
          quarantined,
        },
      };
    });
}

function buildIncidentFindings(securitySnapshot: Record<string, unknown> | null): readonly SecurityFinding[] {
  const incidents = readRecordArray(securitySnapshot?.incidents);
  return incidents.slice(0, 20).map((incident, index): SecurityFinding => {
    const id = safeText(incident.id, `incident-${index + 1}`);
    return {
      findingId: `incident-${slug(id)}`,
      source: 'incident',
      severity: 'warn',
      title: `Security incident ${id}`,
      summary: safeText(incident.title ?? incident.summary ?? incident.kind, 'Security incident recorded.'),
      route: 'capability_run security.review (Permissions and safety, This conversation)',
      detail: {
        id,
        kind: safeText(incident.kind),
        createdAt: safeText(incident.createdAt ?? incident.capturedAt),
      },
    };
  });
}

interface SecuritySnapshotReading {
  readonly snapshot: Record<string, unknown> | null;
  /** Why there is no snapshot: the read model is absent, or reading it threw. */
  readonly reason?: string;
}

function readSecuritySnapshotReading(context: CommandContext): SecuritySnapshotReading {
  const model = context.platform.readModels?.security;
  if (!model) return { snapshot: null, reason: 'No security read model is attached to this Agent context.' };
  try {
    const snapshot: unknown = model.getSnapshot();
    return isRecord(snapshot) ? { snapshot } : { snapshot: null, reason: 'The security read model returned no snapshot.' };
  } catch (error) {
    return { snapshot: null, reason: `Reading the security read model failed: ${previewHarnessText(error instanceof Error ? error.message : String(error), 160)}` };
  }
}

function readSecuritySnapshot(context: CommandContext): Record<string, unknown> | null {
  return readSecuritySnapshotReading(context).snapshot;
}

/**
 * Finding ids come from each finding's own identity (token label, rule and
 * message, server and route), so an id stays the same when another finding is
 * resolved. Two findings with the same identity keep it with a count suffix.
 */
export function buildSecurityFindings(context: CommandContext, securitySnapshot = readSecuritySnapshot(context),
  policySnapshot: unknown = context.extensions.policyRuntimeState?.getSnapshot()): readonly SecurityFinding[] {
  const seen = new Map<string, number>();
  return [
    ...buildTokenFindings(securitySnapshot),
    ...buildPolicyFindings(policySnapshot),
    ...buildMcpFindings(securitySnapshot),
    ...buildPluginFindings(securitySnapshot),
    ...buildIncidentFindings(securitySnapshot),
  ].map((finding) => {
    const count = (seen.get(finding.findingId) ?? 0) + 1;
    seen.set(finding.findingId, count);
    return count === 1 ? finding : { ...finding, findingId: `${finding.findingId}-${count}` };
  }).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.findingId.localeCompare(b.findingId));
}

function countByString(records: readonly Record<string, unknown>[], key: string, value: string): number {
  return records.filter((record) => record[key] === value).length;
}

export function securityPostureCatalogStatus(context: CommandContext): Record<string, unknown> {
  const { snapshot: securitySnapshot, reason } = readSecuritySnapshotReading(context);
  return {
    modes: ['security_posture', 'security_finding'],
    status: securitySnapshot ? 'available' : 'unavailable',
    ...(!securitySnapshot && reason ? { unavailableReason: reason } : {}),
    findings: securitySnapshot ? buildSecurityFindings(context, securitySnapshot).length : 0,
    readOnly: true,
  };
}

// The security and policy snapshots are copies taken once, when the call starts;
// the answer is built from those values and stamped with that time, so tool calls
// passing the gate meanwhile cannot invalidate it.
function captureSecurityRequest(context: CommandContext, args: AgentHarnessSecurityArgs, options: CatalogRankingOptions) {
  const request = captureStatefulCatalogRequest(context, args, options, [
    ['platform', 'readModels', 'security', 'getSnapshot'], ['platform', 'subscriptionManager', 'list'],
    ['platform', 'subscriptionManager', 'listPending'], ['platform', 'serviceRegistry', 'getAll'],
    ['platform', 'secretsManager', 'list'], ['extensions', 'policyRuntimeState', 'getSnapshot'],
  ]);
  const capturedAt = Date.now();
  const { snapshot: securitySnapshot, reason: unavailableReason } = readSecuritySnapshotReading(context);
  const policySnapshot = context.extensions.policyRuntimeState?.getSnapshot() ?? null;
  return { request, securitySnapshot, unavailableReason, policySnapshot, capturedAt };
}

/** The counted sections of the security summary, derived only from the snapshot and the findings built from it. */
export function securitySnapshotSummary(securitySnapshot: Record<string, unknown>, findings: readonly SecurityFinding[]) {
  const audit = isRecord(securitySnapshot.audit) ? securitySnapshot.audit : {};
  const policy = isRecord(securitySnapshot.policy) ? securitySnapshot.policy : {};
  const auditResults = readRecordArray(audit.results);
  const mcpServers = readRecordArray(securitySnapshot.mcpServers);
  const plugins = readRecordArray(securitySnapshot.plugins);
  return {
    tokens: {
      total: typeof audit.totalTokens === 'number' ? audit.totalTokens : auditResults.length,
      blocked: auditResults.length > 0 ? auditResults.filter((result) => result.blocked === true).length : readArray(audit.blocked).length,
      scopeViolations: readArray(audit.scopeViolations).length,
      rotationWarnings: readArray(audit.rotationWarnings).length,
      rotationOverdue: auditResults.length > 0
        ? auditResults.filter((result) => isRecord(result.rotation) && result.rotation.outcome === 'overdue').length
        : readArray(audit.rotationOverdue).length,
    },
    policy: {
      preflightStatus: safeText(policy.preflightStatus),
      preflightIssueCount: typeof policy.preflightIssueCount === 'number' ? policy.preflightIssueCount : 0,
      lintFindings: typeof policy.lintFindingCount === 'number' ? policy.lintFindingCount : 0,
      deniedPermissions: typeof securitySnapshot.deniedPermissions === 'number' ? securitySnapshot.deniedPermissions : 0,
    },
    mcp: {
      servers: mcpServers.length,
      quarantined: countByString(mcpServers, 'schemaFreshness', 'quarantined'),
      elevated: countByString(mcpServers, 'trustMode', 'allow-all'),
      attackPathFindings: findings.filter((finding) => finding.findingId.startsWith('mcp-attack-')).length,
    },
    plugins: {
      total: plugins.length,
      quarantined: plugins.filter((plugin) => plugin.quarantined === true).length,
      untrusted: countByString(plugins, 'trustTier', 'untrusted'),
    },
  };
}

export async function securityPostureSummary(context: CommandContext, args: AgentHarnessSecurityArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const { request, securitySnapshot, unavailableReason: reason, policySnapshot, capturedAt } = captureSecurityRequest(context, args, options);
  args = request.input;
  if (!securitySnapshot) {
    // Policy lint findings come from their own snapshot and stay useful without the security read model.
    const policyFindings = buildPolicyFindings(policySnapshot);
    const returnedFindings = policyFindings.slice(0, readLimit(args.limit, 100));
    return {
      status: 'unavailable',
      capturedAt: new Date(capturedAt).toISOString(),
      ...(reason ? { unavailableReason: reason } : {}),
      findings: returnedFindings.map((finding) => describeFinding(finding, args.includeParameters === true)),
      returned: returnedFindings.length,
      total: policyFindings.length,
      policy: 'Security read models are unavailable in this Agent context; only policy findings, if any, are listed.',
    };
  }
  const subscriptions = context.platform.subscriptionManager;
  const services = context.platform.serviceRegistry;
  const query = readString(args.query);
  const findings = buildSecurityFindings(context, securitySnapshot, policySnapshot);
  const ranked = query ? await rankStatefulCatalog(findings, query, finding => ({ id: finding.findingId, description: finding.title }), 'agent.security.findings', request.options, { securitySnapshot, policySnapshot, args: request.input }) : findings;
  request.assertCurrent();
  const filtered = ranked.slice(0, readLimit(args.limit, 100));
  let secretRefCount: number | null = null;
  let secretRefsError: string | null = null;
  if (args.includeParameters === true && context.platform.secretsManager) {
    try {
      secretRefCount = (await context.platform.secretsManager.list()).length;
    } catch (error) {
      secretRefCount = null;
      secretRefsError = previewHarnessText(error instanceof Error ? error.message : String(error), 160);
    }
  }
  request.assertCurrent();
  return {
    status: 'available',
    capturedAt: new Date(capturedAt).toISOString(),
    summary: {
      ...securitySnapshotSummary(securitySnapshot, findings),
      auth: {
        builtInProviders: listBuiltinSubscriptionProviders().length,
        activeSubscriptions: subscriptions?.list().length ?? 0,
        pendingSubscriptions: subscriptions?.listPending().length ?? 0,
        configuredServices: services ? Object.keys(services.getAll()).length : 0,
        ...(secretRefCount !== null ? { secretRefs: secretRefCount } : {}),
        ...(secretRefsError !== null ? { secretRefsError } : {}),
      },
    },
    findings: filtered.map((finding) => describeFinding(finding, args.includeParameters === true)),
    returned: filtered.length,
    total: findings.length,
    policy: 'Read-only security posture. Token rotation, policy changes, MCP trust changes, bundle export/import, auth repair, and voice enable/disable remain confirmation-gated workspace or slash-command flows.',
    ...(args.includeParameters === true ? { modelAccess: {
      reviewCommand: 'capability_run security.review (Permissions and safety, This conversation)',
      tokensCommand: 'capability_run security.tokens (Permissions and safety, Device tokens)',
      attackPathsCommand: 'capability_run security.attack-paths (Permissions and safety, This conversation)',
      trustReviewCommand: 'capability_run security.trust (Permissions and safety, Policy)',
      authReviewCommand: 'capability_run auth.review (Models and providers, Providers)',
      bundleCatalogMode: 'support_bundles',
      singleFindingMode: 'security_finding',
    } } : {}),
  };
}

export async function describeHarnessSecurityFinding(context: CommandContext, args: AgentHarnessSecurityArgs, options: CatalogRankingOptions = {}): Promise<SecurityFindingResolution> {
  const { request, securitySnapshot, unavailableReason, policySnapshot } = captureSecurityRequest(context, args, options);
  args = request.input;
  const findingId = readString(args.findingId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = findingId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'security_finding requires findingId, target, or query. Use mode:"security_posture" to inspect current finding ids.',
    };
  }
  const findings = buildSecurityFindings(context, securitySnapshot, policySnapshot);
  request.assertCurrent();
  const exact = findings.find((finding) => finding.findingId === input);
  if (exact) return { status: 'found', finding: describeFinding(exact, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const normalized = input.toLowerCase();
  const insensitive = findings.find((finding) => finding.findingId.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', finding: describeFinding(insensitive, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  if (!securitySnapshot) {
    // Only policy findings exist without the read model; a search could resolve a token, MCP,
    // plugin or incident id to an unrelated policy finding, so the miss is said as it is.
    return {
      status: 'missing_lookup',
      usage: `The security read model is unavailable${unavailableReason ? ` (${unavailableReason})` : ''}; only policy findings can be looked up now, so ${input} may still exist. Use mode:"security_posture" to see the status.`,
    };
  }
  const selected = await selectHarnessCatalog(findings, input, finding => ({ id: finding.findingId, description: finding.title }), request.options, 'agent.security.finding');
  request.assertCurrent();
  if (selected) return { status: 'found', finding: describeFinding(selected, true, { source: findingId ? 'findingId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  return {
    status: 'missing_lookup',
    usage: `Unknown security finding ${input}. Use mode:"security_posture" to inspect current finding ids.`,
  };
}


export function supportBundleCatalogStatus(): Record<string, unknown> {
  return {
    modes: ['support_bundles', 'support_bundle'],
    bundleTypes: SUPPORT_BUNDLE_ROUTES.length,
    readOnlyInspection: true,
  };
}

export async function supportBundleSummary(args: AgentHarnessSecurityArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const request = captureCatalogReadRequest(args, options);
  args = request.input;
  const query = readString(args.query);
  const ranked = query ? await rankStatefulCatalog(SUPPORT_BUNDLE_ROUTES, query, route => ({ id: route.bundleType, description: route.inspectCommand, evidence: { route, args: request.input } }), 'agent.support.bundle-routes', request.options) : SUPPORT_BUNDLE_ROUTES;
  request.assertCurrent();
  const routes = ranked
    .slice(0, readLimit(args.limit, 100))
    .map((route) => ({
      bundleType: route.bundleType,
      defaultPath: route.defaultPath,
      inspectCommand: route.inspectCommand,
      modelRoute: supportBundleModelRoute(),
      ...(args.includeParameters === true ? {
        exportCommand: route.exportCommand,
        ...(route.importCommand ? { importCommand: route.importCommand } : {}),
        parameters: {
          bundlePath: 'Path inside the workspace for support_bundle inspection; paths outside it are refused.',
          confirm: 'Export and import are the capabilities bundle.export and bundle.import (capability_run), asked under the person\'s mode.',
        },
      } : {
        summary: previewHarnessText(`${route.bundleType} bundle inspection route`),
      }),
    }));
  return {
    bundles: routes,
    returned: routes.length,
    total: SUPPORT_BUNDLE_ROUTES.length,
    policy: 'Bundle catalog is read-only. Existing bundle inspection returns counts and redaction metadata only; bundle export/import stays confirmation-gated through capabilities or slash-command mirrors.',
  };
}

const SUPPORT_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

type BundlePathResolution =
  | { readonly status: 'ok'; readonly path: string }
  | { readonly status: 'refused'; readonly usage: string };

function resolveBundlePath(context: CommandContext, args: AgentHarnessSecurityArgs): BundlePathResolution {
  const raw = readString(args.bundlePath) || readString(args.target);
  if (!raw) {
    return {
      status: 'refused',
      usage: 'support_bundle requires bundlePath or target holding a workspace-relative bundle path. Use mode:"support_bundles" to inspect bundle routes.',
    };
  }
  const shellPaths = context.workspace.shellPaths;
  const outside = `Bundle path ${previewHarnessText(raw, 120)} is outside the workspace. support_bundle only reads files inside the workspace; export the bundle into the workspace (for example with the bundle export route from mode:"support_bundles") and pass that path.`;
  // The containment test follows links, so a link inside the workspace that leads outside it is refused.
  if (!shellPaths || !shellPaths.isWithinWorkingDirectory(raw)) return { status: 'refused', usage: outside };
  return { status: 'ok', path: shellPaths.resolveWorkspacePath(raw) };
}

function summarizeBundleType(bundle: Record<string, unknown>): string {
  const type = readString(bundle.type);
  if (type) return type;
  if ('permissionMode' in bundle && 'mcpSummary' in bundle) return 'trust-review';
  if ('externalRuntimeAuth' in bundle) return 'auth-review';
  if ('subscriptions' in bundle && 'provider' in bundle) return 'subscription';
  if ('voice' in bundle || 'tts' in bundle) return 'voice';
  return 'unknown';
}

function timestampForBundle(bundle: Record<string, unknown>): number | null {
  const value = bundle.capturedAt ?? bundle.exportedAt ?? bundle.createdAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizeSupportBundle(path: string, bundle: Record<string, unknown>): Record<string, unknown> {
  const redaction = isRecord(bundle.redaction) ? bundle.redaction : {};
  const diagnostics = isRecord(bundle.diagnostics) ? bundle.diagnostics : {};
  const timestamp = timestampForBundle(bundle);
  const mcpSummary = isRecord(bundle.mcpSummary) ? bundle.mcpSummary : {};
  const pluginSummary = isRecord(bundle.pluginSummary) ? bundle.pluginSummary : {};
  return {
    path,
    type: summarizeBundleType(bundle),
    version: safeText(bundle.version),
    capturedAt: timestamp === null ? null : new Date(timestamp).toISOString(),
    topLevelSections: Object.keys(bundle).filter((key) => key !== 'config' && key !== 'secrets'),
    counts: {
      configValues: countNestedLeaves(bundle.config),
      redactedConfigPaths: readArray(redaction.redactedConfigPaths).length,
      diagnosticSections: Object.keys(diagnostics).length,
      secretRefs: readArray(bundle.secretKeys).length,
      serviceNames: readArray(bundle.serviceNames).length,
      activeSubscriptions: readArray(bundle.activeSubscriptions).length,
      pendingSubscriptions: readArray(bundle.pendingSubscriptions).length,
      providerSnapshots: readArray(readNestedValue(bundle, 'diagnostics.providers')).length,
      mcpServers: typeof mcpSummary.total === 'number' ? mcpSummary.total : 0,
      plugins: typeof pluginSummary.total === 'number' ? pluginSummary.total : 0,
    },
    redaction: {
      sentinelPresent: typeof redaction.sentinel === 'string',
      hasRedactedConfigPaths: readArray(redaction.redactedConfigPaths).length > 0,
    },
    policy: {
      effect: 'read-only',
      values: 'Bundle inspection returns structure, counts, timestamps, and redaction metadata only. Raw config values, token values, and secret payloads are not returned.',
      mutation: 'Bundle export/import is capability_run id:"bundle.export" or id:"bundle.import", asked under the person\'s mode.',
    },
  };
}

export function describeHarnessSupportBundle(context: CommandContext, args: AgentHarnessSecurityArgs): SupportBundleResolution {
  const resolution = resolveBundlePath(context, args);
  if (resolution.status === 'refused') return { status: 'missing_lookup', usage: resolution.usage };
  const path = resolution.path;
  if (!existsSync(path)) {
    return {
      status: 'missing_lookup',
      usage: `Bundle file not found: ${path}. Use mode:"support_bundles" to inspect bundle export and inspect routes.`,
    };
  }
  let parsed: unknown;
  try {
    const stats = statSync(path);
    // A FIFO or device reports size 0 and would block the synchronous read.
    if (!stats.isFile()) {
      return {
        status: 'missing_lookup',
        usage: `${path} is not a regular file and was not read. Pass the path of an exported support bundle JSON file.`,
      };
    }
    if (stats.size > SUPPORT_BUNDLE_MAX_BYTES) {
      return {
        status: 'missing_lookup',
        usage: `Bundle file ${path} is larger than ${SUPPORT_BUNDLE_MAX_BYTES / (1024 * 1024)} MiB and was not read. Inspect it with the slash-command route from mode:"support_bundles".`,
      };
    }
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    // The parser message quotes the start of the file, so it is not repeated.
    return {
      status: 'missing_lookup',
      usage: `${path} is not a valid support bundle: it is not parseable JSON.`,
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: 'missing_lookup',
      usage: `${path} is not a valid support bundle: expected a JSON object.`,
    };
  }
  return {
    status: 'found',
    bundle: summarizeSupportBundle(path, parsed),
  };
}
