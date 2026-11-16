/**
 * Deterministic fixtures of the config-modal surfaces, for the render and
 * registration tests: frozen data, fixed clocks, no live services.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { UiSecuritySnapshot } from '../../runtime/ui-read-models.ts';
import type { DivergenceStats, PolicyBundleVersion } from '@/runtime/index.ts';
import { describeOriginPosture, type PublicPairingToken } from '@goodvibes-jev/engine/platform/platform/pairing';
import type { PluginStatus } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import type { MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { createDevicesModalSurface } from '../../views/modals/devices-modal.ts';
import { createPolicyModalSurface, type PolicyModalSnapshot } from '../../views/modals/policy-modal.ts';
import { createMarketplaceModalSurface } from '../../views/modals/marketplace-modal.ts';
import { createPairingModalSurface, type PairingModalConnectionInfo } from '../../views/modals/pairing-modal.ts';
import { createKnowledgeModalSurface, type KnowledgeNodeLike, type KnowledgeSourceLike, type KnowledgeIssueLike, type KnowledgeScheduleLike } from '../../views/modals/knowledge-modal.ts';
import { createPluginsModalSurface, type PluginsModalManager } from '../../views/modals/plugins-modal.ts';
import { createKeybindingsModalSurface, type KeybindingsModalToolRegistry, type KeybindingsModalProviderRegistry } from '../../views/modals/keybindings-modal.ts';
import { createWorkPlanModalSurface, type WorkPlanItemLike } from '../../views/modals/work-plan-modal.ts';
import { createHooksModalSurface, type HookEntry, type HooksModalDispatcher, type HooksModalWorkbench, type HooksModalActivityTracker } from '../../views/modals/hooks-modal.ts';
import { createSkillsModalSurface } from '../../views/modals/skills-modal.ts';
import { createSecurityModalSurface } from '../../views/modals/security-modal.ts';
import { createMemoryModalSurface } from '../../views/modals/memory-modal.ts';

/**
 * Deterministic golden/render fixture: frozen token list + clock so last-seen
 * formatting is stable.
 */
export function devicesModalGoldenSurface(): ConfigModalSurface {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const tokens: PublicPairingToken[] = [
    { id: 'aaaa1111bbbb2222', name: 'my laptop', createdAt: Date.UTC(2026, 6, 10, 9, 0, 0), lastSeenAt: now - 3 * 60_000 },
    { id: 'cccc3333dddd4444', name: 'kitchen tablet', createdAt: Date.UTC(2026, 6, 1, 9, 0, 0), lastSeenAt: now - 5 * 60 * 60_000 },
    { id: 'eeee5555ffff6666', name: 'phone (never scanned)', createdAt: Date.UTC(2026, 6, 13, 8, 0, 0) },
  ];
  let legacyRevoked = false;
  return createDevicesModalSurface({
    now: () => now,
    pairingTokens: {
      list: () => tokens,
      rename: () => true,
      revoke: () => true,
      mintForMigration: () => ({ id: 'new', name: 'migrated device', token: 'tok', createdAt: now }),
      isLegacyRevoked: () => legacyRevoked,
      revokeLegacyShared: () => { legacyRevoked = true; },
    },
  });
}

/**
 * Deterministic golden fixture. A fixed `PolicyModalSnapshot` literal covering
 * every rendered branch in one shot: an active current bundle, a simulating
 * candidate, a 3-rule diff, a blocked divergence gate with one command-prefix
 * and one tool-class breakdown row, one rolled-back history entry, one denied
 * permission-audit entry, one lint warning, one preflight review with one issue,
 * and one diverged simulation sample. No Date.now().
 */
export function policyModalGoldenSurface(): ConfigModalSurface {
  const currentBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-current-1', issuedAt: '2023-11-01T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-current-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-01T00:00:00.000Z', issuer: 'ops' },
    rules: [{ id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] }],
    state: 'active', loadedAt: '2023-11-01T00:00:00.000Z', activatedAt: '2023-11-01T00:05:00.000Z',
  };
  const candidateBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-candidate-1', issuedAt: '2023-11-10T00:00:00.000Z', payload: { version: 1, rules: [] }, issuer: 'ops' },
    provenance: { policyBundleId: 'bundle-candidate-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-11-10T00:00:00.000Z', issuer: 'ops' },
    rules: [
      { id: 'rule-base-1', type: 'prefix', origin: 'managed', effect: 'allow', toolPattern: '*', commandPrefixes: [] },
      { id: 'rule-added-1', type: 'network-scope', origin: 'user', effect: 'deny', toolPattern: 'Fetch', hostPatterns: ['*'] },
    ],
    state: 'simulating', loadedAt: '2023-11-10T00:00:00.000Z',
  };
  const historyBundle: PolicyBundleVersion = {
    bundle: { bundleId: 'bundle-prev-1', issuedAt: '2023-10-01T00:00:00.000Z', payload: { version: 1, rules: [] } },
    provenance: { policyBundleId: 'bundle-prev-1', signatureStatus: 'unsigned', provenanceSource: 'local-file', issuedAt: '2023-10-01T00:00:00.000Z' },
    rules: [], state: 'rolled-back', loadedAt: '2023-10-01T00:00:00.000Z', activatedAt: '2023-10-01T00:05:00.000Z', rolledBackAt: '2023-11-01T00:00:00.000Z',
  };
  const removedRule = { id: 'rule-removed-1', type: 'path-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: '*', pathPatterns: ['/tmp/**'] };
  const addedRule = { id: 'rule-added-1', type: 'network-scope' as const, origin: 'user' as const, effect: 'deny' as const, toolPattern: 'Fetch', hostPatterns: ['*'] };
  const changedFrom = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'allow' as const, toolPattern: '*', commandPrefixes: [] };
  const changedTo = { id: 'rule-base-1', type: 'prefix' as const, origin: 'managed' as const, effect: 'deny' as const, toolPattern: '*', commandPrefixes: [] };
  const stats = (divergenceRate: number): DivergenceStats => ({ total: 1, byType: { 'allow-vs-deny': 1, 'deny-vs-allow': 0, 'reason-mismatch': 0 }, divergenceRate, totalEvaluations: 20 });
  const decision = (allowed: boolean, reason: 'DEFAULT_ALLOW' | 'RULE_DENY_USER') => ({ allowed, reason, sourceLayer: 'policy' as const, toolName: 'Fetch', args: {}, timestamp: 1700000000000, evaluationTrace: [] });

  const snapshot: PolicyModalSnapshot = {
    current: currentBundle, candidate: candidateBundle, history: [historyBundle],
    diff: { fromBundleId: 'bundle-current-1', toBundleId: 'bundle-candidate-1', removed: [removedRule], added: [addedRule], changed: [{ ruleId: 'rule-base-1', from: changedFrom, to: changedTo }], unchanged: [], totalChanges: 3 },
    divergence: {
      report: { overall: stats(0.1), byToolClass: { network: stats(0.1) }, byCommandPrefix: { 'fetch ': stats(0.1) }, byMode: {}, records: [] },
      mode: 'warn-on-divergence',
      gate: { status: 'blocked', divergenceRate: 0.1, threshold: 0.05, totalEvaluations: 20, message: 'divergence rate 10.0% exceeds 5.0% threshold' },
      trend: [{ ts: 1700000000000, divergenceRate: 0.1, totalEvaluations: 20, totalDivergences: 2, gatePassing: false }],
      capturedAt: 1700000000000,
    },
    recentPermissionAudit: [{ callId: 'call-1', tool: 'Bash', category: 'exec', approved: false, riskLevel: 'high', classification: 'destructive', summary: 'blocked rm -rf outside sandbox root', reasons: ['path escape'], requestedAt: 1700000000000, decidedAt: 1700000001000 }],
    lintFindings: [{ severity: 'warn', ruleId: 'rule-added-1', message: 'toolPattern "Fetch" combined with a wildcard host pattern is broad; consider narrowing.' }],
    lastSimulationSummary: {
      simulatedAt: '2023-11-10T00:00:00.000Z', mode: 'warn-on-divergence', totalScenarios: 4, divergentScenarios: 1, allowedByActual: 3, allowedBySimulated: 2,
      results: [{ scenario: { id: 'scenario-1', label: 'fetch external API', toolName: 'Fetch', args: {} }, actualDecision: decision(true, 'DEFAULT_ALLOW'), simulatedDecision: decision(false, 'RULE_DENY_USER'), authoritativeDecision: decision(true, 'DEFAULT_ALLOW'), diverged: true, divergenceType: 'allow-vs-deny' }],
    },
    lastPreflightReview: {
      generatedAt: '2023-11-10T00:10:00.000Z', status: 'warn', summary: '1 candidate rule broadens network access beyond the current policy.', issueCount: 1,
      issues: [{ severity: 'warn', source: 'policy', message: 'candidate rule rule-added-1 denies all outbound network access', detail: 'verify this is intentional before promotion' }],
    },
    capturedAt: '2023-11-10T00:15:00.000Z',
  };
  return createPolicyModalSurface({ policyRuntimeState: { getSnapshot: () => snapshot } });
}

/**
 * Deterministic golden fixture: catalog roots wired at a fresh tmp path that is
 * removed immediately (loadEcosystemCatalog/listInstalledEcosystemEntries guard
 * missing paths with existsSync → [], so refresh() finds nothing and renders the
 * honest empty-state copy). The random tmp path never appears in the
 * rendered lines (the empty-state copy is static), so the golden is byte-stable.
 *
 * Created and removed synchronously in the same call.
 */
export function marketplaceModalGoldenSurface(): ConfigModalSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-marketplace-golden-'));
  const surface = createMarketplaceModalSurface({
    ecosystemPaths: { cwd: root, homeDir: root, projectCatalogRoot: join(root, 'ecosystem') },
  });
  rmSync(root, { recursive: true, force: true });
  return surface;
}

/**
 * Deterministic golden fixture: a frozen connectionInfo literal (the QR renders
 * purely from its deepLink via generateQrMatrix) and a frozen control-plane
 * snapshot.
 */
export function pairingModalGoldenSurface(): ConfigModalSurface {
  const connectionInfo: PairingModalConnectionInfo = {
    url: 'http://workshop.local:3141',
    token: 'golden-token-0123456789abcdef',
    tokenName: 'golden device',
    deepLink: 'http://workshop.local:3141/#pair=golden-token-0123456789abcdef&offers=notifications~relay~passkey',
    offers: ['notifications', 'relay', 'passkey'],
    posture: describeOriginPosture('http://workshop.local:3141'),
  };
  return createPairingModalSurface({
    getConnectionInfo: () => connectionInfo,
    controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['golden-client-1'] }) },
    copyToClipboard: () => {},
  });
}

/**
 * Deterministic golden fixture: fixed node/source/issue/schedule records,
 * no live platform calls, no random ids, no wall-clock reads.
 */
export function knowledgeModalGoldenSurface(): ConfigModalSurface {
  const nodes: readonly KnowledgeNodeLike[] = [{ id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched internal releases, no per-change tags.' }];
  const sources: readonly KnowledgeSourceLike[] = [{ id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', canonicalUri: 'repo://goodvibes-tui', summary: 'Primary TUI repository.' }];
  const issues: readonly KnowledgeIssueLike[] = [{ id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Source has not been recrawled in 30 days.', status: 'open', sourceId: 'source-1' }];
  const schedules: readonly KnowledgeScheduleLike[] = [{ id: 'sched-1', label: 'Nightly reindex', enabled: true }];
  return createKnowledgeModalSurface({
    knowledgeApi: {
      graph: { nodes: { list: async () => nodes }, issues: { list: async () => issues } },
      sources: { list: async () => sources },
      jobs: { schedules: { list: () => schedules } },
    },
  });
}

/**
 * Deterministic golden fixture: a fixed two-plugin roster (one active/trusted,
 * one quarantined/untrusted) so both the base list rendering and the quarantine
 * suffix are exercised without any disk I/O, wall-clock, or random ids.
 */
export function pluginsModalGoldenSurface(): ConfigModalSurface {
  const fixedPlugins: PluginStatus[] = [
    { name: 'formatter', version: '1.0.0', description: 'Deterministic golden fixture plugin.', enabled: true, active: true, trustTier: 'trusted', quarantined: false },
    { name: 'risky-tool', version: '0.2.0', description: 'Second golden fixture plugin, quarantined.', enabled: false, active: false, trustTier: 'untrusted', quarantined: true },
  ];
  const manager: PluginsModalManager = {
    list: () => fixedPlugins,
    capabilities: () => null,
    getTrustRecord: () => undefined,
    getQuarantineRecord: (name) => (name === 'risky-tool'
      ? { pluginName: name, quarantinedAt: 0, reason: 'golden fixture quarantine', revokedCapabilities: [], lifted: false }
      : undefined),
    verify: () => ({ ok: true, valid: true, fingerprint: 'golden-fixture-fp' }),
  };
  return createPluginsModalSurface({ pluginManager: manager });
}

/**
 * Deterministic golden fixture. KeybindingsManager is pointed at a nonexistent
 * config path so it always resolves to DEFAULT_KEYBINDINGS. Tool and model
 * fixtures are frozen literals, no disk, no live registry.
 */
export function keybindingsModalGoldenSurface(): ConfigModalSurface {
  const keybindingsManager = new KeybindingsManager({ configPath: '/nonexistent/golden-keybindings.json' });
  const toolRegistry: KeybindingsModalToolRegistry = {
    list: () => [
      { definition: { name: 'read_file', description: 'Read a file from disk.', sideEffects: ['read_fs'], concurrency: 'parallel', supportsProgress: false, supportsStreamingOutput: false } },
      { definition: { name: 'run_shell', description: 'Execute a shell command.', sideEffects: ['exec'], concurrency: 'serial', supportsProgress: true, supportsStreamingOutput: true } },
    ],
  };
  const providerRegistry: KeybindingsModalProviderRegistry = {
    listModels: () => [
      { id: 'golden-a', provider: 'golden-provider', registryKey: 'golden-provider:golden-a', displayName: 'Golden Model A', contextWindow: 128000, selectable: true },
      { id: 'golden-b', provider: 'golden-provider', registryKey: 'golden-provider:golden-b', displayName: 'Golden Model B', contextWindow: 32000, selectable: false },
    ],
    getCurrentModel: () => ({ registryKey: 'golden-provider:golden-a' }),
  };
  return createKeybindingsModalSurface({ toolRegistry, providerRegistry, keybindingsManager });
}

/**
 * Deterministic golden fixture: fixed work-plan items with frozen updatedAt
 * epoch values, no live store, no wall-clock, no random ids.
 */
export function workPlanModalGoldenSurface(): ConfigModalSurface {
  const FIXED_UPDATED_AT = 1735693200000; // 2025-01-01T01:00:00.000Z
  const items: readonly WorkPlanItemLike[] = [
    { id: 'wpi-fixed001', title: 'Migrate KNOWLEDGE/MEMORY/WORK-PLAN panels to modals', status: 'in_progress', owner: 'wo-b', source: 'tui-panel', notes: 'Charter: read/navigate only; mutations route to the command path.', linked: { agentId: 'agent-fixed-1' }, updatedAt: FIXED_UPDATED_AT },
    { id: 'wpi-fixed002', title: 'Wire modal host redirects', status: 'pending', updatedAt: FIXED_UPDATED_AT },
  ];
  return createWorkPlanModalSurface({ workPlanStore: { getActivePlan: () => ({ projectRoot: '/fixed/project', items }) } });
}

/**
 * Deterministic golden fixture: fixed dispatcher/workbench/activity-tracker
 * stand-ins with two managed hooks (one enabled, one disabled) and one recorded
 * activity entry. listHookPointContracts() reads the platform's static contract table
 * (no disk/wall-clock). All timestamps are fixed epoch numbers.
 */
export function hooksModalGoldenSurface(): ConfigModalSurface {
  const hooks: HookEntry[] = [
    { pattern: 'Pre:tool:*', hook: { match: 'Pre:tool:*', type: 'command', command: 'echo pre', name: 'pre-tool-guard', enabled: true } },
    { pattern: 'Post:file:write', hook: { match: 'Post:file:write', type: 'command', command: 'echo post', name: 'post-write-log', enabled: false } },
  ];
  const dispatcher: HooksModalDispatcher = { listHooks: () => hooks, getChains: () => [] };
  const workbench: HooksModalWorkbench = {
    getHooksFilePath: () => '/golden/hooks.json',
    listManagedHooks: () => hooks,
    listManagedChains: () => [],
    listRecentActions: () => [{ kind: 'toggle', target: 'pre-tool-guard', timestamp: 0 }],
    getLastSimulation: () => null,
  };
  const activityTracker: HooksModalActivityTracker = {
    listRecent: () => [{
      timestamp: 0, path: 'Pre:tool:*', specific: '*', pattern: 'Pre:tool:*',
      hookName: 'pre-tool-guard', hookType: 'command', ok: true, decision: 'allow', durationMs: 1, async: false,
    }],
  };
  return createHooksModalSurface({ hookDispatcher: dispatcher, hookWorkbench: workbench, hookActivityTracker: activityTracker });
}

/** Deterministic golden fixture: a surface whose skill read finds nothing, so it renders the empty-state copy. */
export function skillsModalGoldenSurface(): ConfigModalSurface {
  return createSkillsModalSurface({
    shellPaths: { workingDirectory: '/', homeDirectory: '/' },
    discover: async () => [],
  });
}

/**
 * Deterministic golden fixture. A fixed `UiSecuritySnapshot` literal covering
 * the meaningful states in one shot: a clean token, a blocked/overdue/scope-
 * violating token, a quarantined allow-all MCP server, a quarantined plugin,
 * one recorded incident, and one critical attack-path finding. No Date.now().
 */
export function securityModalGoldenSurface(): ConfigModalSurface {
  const FIXED_INCIDENT = {
    id: 'inc-0001', traceId: 'trace-0001', sessionId: 'sess-0001', generatedAt: 1700000000000,
    classification: 'permission_denied' as const, summary: 'blocked write outside sandbox root',
    phaseTimings: [], phaseLedger: [], slowPhases: [], causalChain: [], cascadeEvents: [], permissionEvidence: [], budgetBreaches: [], jumpLinks: [],
  };
  const snapshot: UiSecuritySnapshot = {
    audit: {
      managed: true, totalTokens: 2,
      results: [
        { tokenId: 'tok-openai', label: 'OPENAI_API_KEY', scope: { tokenId: 'tok-openai', outcome: 'ok', excessScopes: [], policyId: 'openai' }, rotation: { tokenId: 'tok-openai', outcome: 'ok', ageMs: 5 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: 85 * 86400000, dueAt: 1707600000000 }, blocked: false },
        { tokenId: 'tok-slack', label: 'SLACK_BOT_TOKEN', scope: { tokenId: 'tok-slack', outcome: 'violation', excessScopes: ['admin'], policyId: 'slack' }, rotation: { tokenId: 'tok-slack', outcome: 'overdue', ageMs: 120 * 86400000, cadenceMs: 90 * 86400000, msUntilDue: -30 * 86400000, dueAt: 1697328000000 }, blocked: true },
      ],
      blocked: ['tok-slack'], scopeViolations: ['tok-slack'], rotationWarnings: [], rotationOverdue: ['tok-slack'],
      lastAuditAt: 1700000000000, capturedAt: '2023-11-14T22:13:20.000Z',
    },
    policy: { preflightStatus: 'warn', preflightIssueCount: 2, lintFindingCount: 1 },
    deniedPermissions: 3, incidents: [FIXED_INCIDENT], latestIncident: FIXED_INCIDENT,
    mcpServers: [{ name: 'fs-server', role: 'filesystem', trustMode: 'allow-all', connected: true, allowedPaths: [], allowedHosts: [], schemaFreshness: 'quarantined', quarantineReason: 'stale_threshold', quarantineDetail: 'ttl expired 2 days ago' }],
    recentMcpDecisions: [],
    attackPathReview: {
      reviewedAt: 1700000000000, totalServers: 1, connectedServers: 1, allowAllServers: 1, askOnRiskServers: 0, constrainedServers: 0, blockedServers: 0, quarantinedServers: 1, incoherentFindings: 1, criticalFindings: 1,
      findings: [{ kind: 'server-posture', serverName: 'fs-server', route: 'fs-server -> write_fs', verdict: 'ask', severity: 'critical', incoherent: true, reason: 'allow-all trust combined with a quarantined schema', evidence: ['schemaFreshness=quarantined', 'trustMode=allow-all'] }],
      summary: '1 server in allow-all mode with a quarantined schema',
    },
    plugins: [],
    quarantinedPlugins: [{ name: 'legacy-formatter', version: '0.1.0', description: 'old formatter plugin', enabled: false, active: false, trustTier: 'untrusted', quarantined: true }],
    untrustedPlugins: [],
  };
  return createSecurityModalSurface({ readModel: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
}

/**
 * Deterministic golden fixture: fixed memory records with frozen createdAt
 * timestamps, no live registry, no wall-clock, no random ids. Promise-backed
 * (see ecosystem-modals-golden.test.ts): `honestSearch` is async even for this
 * in-memory fixture (matching the real MemoryAccess shape), so the factory
 * pre-awaits the initial `onOpen` refresh before handing back the surface.
 */
export async function memoryModalGoldenSurface(): Promise<ConfigModalSurface> {
  const FIXED_CREATED_AT = 1735689600000; // 2025-01-01T00:00:00.000Z
  const records: readonly MemoryRecord[] = [
    {
      id: 'mem-0000001a', scope: 'project', cls: 'decision',
      summary: 'Panel retirements are batched behind modal builders.',
      detail: 'Applies to the knowledge, memory, and work-plan modals.',
      tags: ['panels', 'modals'], reviewState: 'reviewed', confidence: 90,
      reviewedAt: FIXED_CREATED_AT + 3600000, reviewedBy: 'operator', createdAt: FIXED_CREATED_AT, updatedAt: FIXED_CREATED_AT,
      provenance: [{ kind: 'session', ref: 'session-fixed-1' }],
    },
    {
      id: 'mem-0000002b', scope: 'session', cls: 'risk',
      summary: 'Modal review actions must not call mutation APIs directly.',
      tags: ['charter'], reviewState: 'stale', confidence: 35,
      staleReason: 'needs re-verification against the charter doc',
      createdAt: FIXED_CREATED_AT + 86400000, updatedAt: FIXED_CREATED_AT + 86400000, provenance: [],
    },
  ];
  const surface = createMemoryModalSurface({
    memoryRegistry: {
      honestSearch: async () => ({
        records, mode: 'literal', requestedSemantic: false, indexUnavailableReason: null,
        caveat: null, recallFiltered: false, excludedFlaggedCount: 0,
        excludedBelowFloorCount: 0, excludedOutOfWindowCount: 0,
        totalBeforeRecallFilter: records.length, recallFloor: 60,
      }),
      reviewQueue: async () => [records[1]!, records[0]!],
    },
  });
  surface.onOpen?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
