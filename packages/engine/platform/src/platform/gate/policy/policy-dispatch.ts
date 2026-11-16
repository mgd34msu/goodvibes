/**
 * `/policy`, the versioned policy-bundle workflow, as engine logic: load a
 * candidate, simulate it against the active bundle, diff, lint, preflight,
 * promote, roll back, report status and record a divergence trend sample.
 *
 * Hoisted from the TUI (src/input/commands/policy-dispatch.ts). The product
 * keeps its command registration and hands this module a narrow context: a
 * print sink, the policy runtime state (and registry, when the product holds
 * its own), and getters for the working directory, the live config and the
 * MCP servers' security records. Every printed line is unchanged.
 *
 * The divergence gate that `promote` consults (DivergenceDashboard
 * .checkEnforceGate) compares a counted divergence ratio with the owner's
 * configured threshold (`permissions.divergenceThreshold`): arithmetic
 * against an owner setting, kept as code.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeError } from '../../utils/error-display.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { isAbortError } from '../../contract/run-context.js';
import type { DeepReadonly } from '../../config/manager.js';
import type { GoodVibesConfig } from '../../config/schema-types.js';
import {
  buildDefaultPolicySimulationScenarios,
  buildPolicyPreflightReview,
  createPermissionSimulator,
  lintPolicyConfig,
  runPolicySimulationScenarios,
} from '../../runtime/permissions/index.js';
import { DivergenceDashboard } from '../../runtime/permissions/divergence-dashboard.js';
import type { PolicyBundlePayload } from '../../runtime/permissions/policy-loader.js';
import type { PolicyBundleVersion, PolicyRegistry } from '../../runtime/permissions/policy-registry.js';
import type { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.js';
import type { PolicyPreflightServer } from '../../runtime/permissions/preflight.js';
import type { SignedPolicyBundle } from '../../runtime/permissions/policy-signer.js';
import type { DivergenceStats, PermissionsConfig } from '../../runtime/permissions/types.js';

/** One MCP server's security record, as the MCP registry lists it. */
export interface PolicyMcpServerSecurity {
  readonly name: string;
  readonly trustMode: PolicyPreflightServer['trustMode'];
  readonly role: PolicyPreflightServer['role'];
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
}

export interface PolicyCommandContext {
  print(text: string): void;
  /** Absent in a runtime without policy state; the verbs that need it say so. */
  readonly policyRuntimeState?: PolicyRuntimeState | undefined;
  /** A registry the product holds itself; otherwise the runtime state's registry. */
  readonly policyRegistry?: PolicyRegistry | undefined;
  /** The project root the simulation evaluates against (may throw when unavailable). */
  workingDirectory(): string;
  /** The live config: the preflight review reads it, and simulate reads the divergence threshold. */
  config(): DeepReadonly<GoodVibesConfig>;
  /** The MCP servers' security records the preflight review reads. */
  listMcpServerSecurity(): readonly PolicyMcpServerSecurity[];
}

function getPolicyState(ctx?: PolicyCommandContext): PolicyRuntimeState {
  const policyRuntimeState = ctx?.policyRuntimeState;
  if (!policyRuntimeState) {
    throw new Error('Policy runtime state is not available in this runtime.');
  }
  return policyRuntimeState;
}

function getRegistry(ctx?: PolicyCommandContext): PolicyRegistry {
  return ctx?.policyRegistry ?? getPolicyState(ctx).getRegistry();
}

async function refreshLintAfterPolicyChange(context: PolicyCommandContext): Promise<void> {
  try {
    await getPolicyState(context).refreshLint(getRegistry(context));
  } catch (error) {
    context.print(`[policy] Policy change applied, but lint findings could not be refreshed: ${summarizeError(error)}`);
  }
}

function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function bundleSummary(
  label: string,
  version: PolicyBundleVersion,
): string {
  const issuer = version.bundle.issuer ? ` issuer=${version.bundle.issuer}` : '';
  const ts = version.bundle.issuedAt.replace('T', ' ').slice(0, 19);
  return `${label}: ${version.bundle.bundleId} (${ts}${issuer}) [${version.rules.length} rules, ${version.state}]`;
}

const MAX_BUNDLE_FILE_BYTES = 1024 * 1024;

/**
 * Reads a bundle file exactly as exported: `{ bundleId, issuedAt, payload: { version, rules }, signature?, issuer? }`.
 * Nothing is synthesised, so what is promoted later is what the file held, and a signed
 * bundle keeps its signature for the registry to verify.
 */
function readBundleFile(path: string, workingDirectory: string): SignedPolicyBundle<PolicyBundlePayload> {
  const resolved = resolve(workingDirectory, path);
  let text: string;
  try {
    if (statSync(resolved).size > MAX_BUNDLE_FILE_BYTES) throw new Error(`is larger than ${MAX_BUNDLE_FILE_BYTES} bytes`);
    text = readFileSync(resolved, 'utf-8');
  } catch (error) {
    throw new Error(`Could not read ${resolved}: ${summarizeError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${resolved} is not valid JSON.`);
  }
  const bundle = isPlainObject(parsed) ? parsed : null;
  const payload = bundle !== null && isPlainObject(bundle['payload']) ? bundle['payload'] : null;
  if (bundle === null || payload === null
    || typeof bundle['bundleId'] !== 'string' || bundle['bundleId'].length === 0
    || typeof bundle['issuedAt'] !== 'string'
    || typeof payload['version'] !== 'number' || !Array.isArray(payload['rules'])
    || (bundle['signature'] !== undefined && typeof bundle['signature'] !== 'string')
    || (bundle['issuer'] !== undefined && typeof bundle['issuer'] !== 'string')) {
    throw new Error(`${resolved} is not a policy bundle: expected { bundleId, issuedAt, payload: { version, rules: [...] } } with an optional signature and issuer.`);
  }
  const rules: unknown[] = payload['rules'];
  const malformed = rules.findIndex((rule) => !isPlainObject(rule) || typeof rule['id'] !== 'string' || typeof rule['type'] !== 'string' || typeof rule['effect'] !== 'string');
  if (malformed >= 0) throw new Error(`${resolved} is not a policy bundle: rule ${malformed + 1} needs a string id, type and effect.`);
  return parsed as SignedPolicyBundle<PolicyBundlePayload>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleLoad(args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const file = args[0];
  if (!file) {
    context.print('[policy] Nothing was loaded: name the bundle file to load, `/policy load <bundle-file>`.');
    return;
  }
  let bundle: SignedPolicyBundle<PolicyBundlePayload>;
  try {
    bundle = readBundleFile(file, context.workingDirectory());
  } catch (error) {
    context.print(`[policy] Load failed, the current and candidate bundles are unchanged: ${summarizeError(error)}`);
    return;
  }
  const result = registry.loadCandidate(bundle);
  if (!result.ok) {
    context.print(`[policy] Load failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  const candidate = registry.getCandidate();
  if (candidate) {
    policyState.notify();
    context.print(bundleSummary('[policy] Candidate loaded', candidate));
    context.print('[policy] Next: run `/policy simulate` to collect divergence evidence before promoting.');
    await refreshLintAfterPolicyChange(context);
  }
}

async function handleSimulate(args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const projectRoot = context.workingDirectory();
  const candidate = registry.getCandidate();
  const current = registry.getCurrent();
  if (!candidate) {
    context.print('[policy] No candidate bundle loaded. Run `/policy load <bundle-file>` first.');
    return;
  }
  // Read the owner's threshold before the candidate leaves "loaded", so a
  // failing config getter cannot strand it in "simulating".
  // The divergence gate's threshold is the owner's setting, not a number fixed here.
  const threshold = context.config().permissions.divergenceThreshold;
  if (!registry.markSimulating()) {
    const reason = registry.describeCandidateRefusal('simulating') ?? `Candidate is in "${candidate.state}" state`;
    context.print(`[policy] Cannot start simulation: ${reason}.`);
    return;
  }
  const currentConfig: PermissionsConfig = {
    mode: 'default',
    projectRoot,
    rules: current?.rules ?? [],
    defaultEffect: 'allow',
  };
  const candidateForSim = registry.getCandidate();
  if (!candidateForSim) {
    throw new Error('Invariant: candidate disappeared after markSimulating()');
  }
  const candidateConfig: PermissionsConfig = {
    mode: 'default',
    projectRoot,
    rules: candidateForSim.rules,
    defaultEffect: 'allow',
  };
  const modeArg = args[0];
  const simulationMode = modeArg === 'enforce' ? 'enforce' : modeArg === 'silent' ? 'simulation-only' : 'warn-on-divergence';
  const scenarios = buildDefaultPolicySimulationScenarios();
  const simulator = createPermissionSimulator(currentConfig, candidateConfig, simulationMode, {
    divergenceThreshold: threshold,
    maxDivergenceRecords: context.config().permissions.maxDivergenceRecords,
  });
  // The scenario run is the whole evidence set, so the gate judges it rather
  // than reporting "insufficient data" (which passes by default) for a run
  // smaller than the live-traffic minimum.
  const dashboard = new DivergenceDashboard(simulator, simulationMode, { threshold, minEvaluationsForGate: scenarios.length });
  policyState.setDashboard(dashboard);
  context.print(`[policy] Simulation started in "${simulationMode}" mode. Evaluations will be tracked against candidate bundle "${candidate.bundle.bundleId}".`);
  context.print('[policy] Use `/policy diff` to compare rules. When ready, run `/policy promote` to enforce (requires gate passing).');
  const stillCurrent = (): boolean => registry.getCandidate() === candidateForSim && registry.getCurrent() === current && policyState.getDashboard() === dashboard;
  let scenarioSummary: Awaited<ReturnType<typeof runPolicySimulationScenarios>>;
  try {
    scenarioSummary = await runPolicySimulationScenarios(simulator, scenarios);
  } catch (error) {
    if (registry.getCandidate() === candidateForSim) {
      registry.abandonSimulation();
      policyState.notify();
    }
    // A stopped run is the caller's cancellation, not a simulation failure.
    if (isAbortError(error)) throw error;
    context.print(`[policy] Simulation failed: ${summarizeError(error)}. The candidate is back in "loaded" state; run \`/policy simulate\` again.`);
    return;
  }
  if (!stillCurrent()) {
    if (registry.getCandidate() === candidateForSim) {
      registry.abandonSimulation();
      policyState.notify();
      context.print('[policy] Simulation finished after the active policy changed; its results were not applied. Run `/policy simulate` again.');
    } else {
      context.print('[policy] Simulation finished after the active policy changed; its results were not applied.');
    }
    return;
  }
  // Read the evidence after the run, so the gate judges what was simulated.
  const report = simulator.getDivergenceReport();
  const gateResult = dashboard.checkEnforceGate();
  registry.attachSimulationReport(report, gateResult);
  policyState.recordSimulationSummary(scenarioSummary);
  const candidate2 = registry.getCandidate();
  policyState.notify();
  context.print(`[policy] Baseline divergence: ${fmtRate(report.overall.divergenceRate)} (${report.overall.total} divergences / ${report.overall.totalEvaluations} evaluations). Gate: ${gateResult.status}.`);
  context.print(`[policy] Scenario run: ${scenarioSummary.totalScenarios} samples, ${scenarioSummary.divergentScenarios} diverged, ${scenarioSummary.allowedByActual}/${scenarioSummary.allowedBySimulated} allowed (actual/candidate).`);
  if (candidate2) context.print(bundleSummary('[policy] Candidate state', candidate2));
}

async function handleDiff(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const diff = registry.diff();
  if (!diff) {
    const current = registry.getCurrent();
    const candidate = registry.getCandidate();
    if (!current) context.print('[policy] No active bundle. Load a bundle with `/policy load`.');
    else if (!candidate) context.print('[policy] No candidate bundle. Load a candidate with `/policy load`.');
    else context.print('[policy] Diff unavailable.');
    return;
  }
  context.print(`[policy] Diff: ${diff.fromBundleId} → ${diff.toBundleId} (${diff.totalChanges} change${diff.totalChanges !== 1 ? 's' : ''})`);
  context.print(`  Added:    ${diff.added.length} rule${diff.added.length !== 1 ? 's' : ''}`);
  context.print(`  Removed:  ${diff.removed.length} rule${diff.removed.length !== 1 ? 's' : ''}`);
  context.print(`  Changed:  ${diff.changed.length} rule${diff.changed.length !== 1 ? 's' : ''}`);
  context.print(`  Unchanged: ${diff.unchanged.length} rule${diff.unchanged.length !== 1 ? 's' : ''}`);
  if (diff.added.length > 0) {
    context.print('  [+] Added rules:');
    for (const r of diff.added) context.print(`      + ${r.id} (${r.type}, effect=${r.effect})`);
  }
  if (diff.removed.length > 0) {
    context.print('  [-] Removed rules:');
    for (const r of diff.removed) context.print(`      - ${r.id} (${r.type}, effect=${r.effect})`);
  }
  if (diff.changed.length > 0) {
    context.print('  [~] Changed rules:');
    for (const c of diff.changed) context.print(`      ~ ${c.ruleId}`);
  }
  const dashboard = getPolicyState(context).getDashboard();
  if (dashboard) {
    const snap = dashboard.getSnapshot();
    const report = snap.report;
    const prefixEntries = Object.entries(report.byCommandPrefix);
    if (prefixEntries.length > 0) {
      context.print('  [divergence by command prefix]');
      for (const [prefix, stats] of prefixEntries) {
        context.print(`      ${prefix}: ${fmtRate(stats.divergenceRate)} (${stats.total}/${stats.totalEvaluations})`);
      }
    }
    const classEntries = Object.entries(report.byToolClass) as Array<[string, DivergenceStats]>;
    if (classEntries.length > 0) {
      context.print('  [divergence by tool class]');
      for (const [cls, stats] of classEntries) {
        if (!stats) continue;
        context.print(`      ${cls}: ${fmtRate(stats.divergenceRate)} (${stats.total}/${stats.totalEvaluations})`);
      }
    }
  }
}

async function handleLint(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  if (!current && !candidate) {
    context.print('[policy] No policy bundles loaded. Use `/policy load` to begin.');
    return;
  }
  const findings = [
    ...(current ? (await lintPolicyConfig({ mode: 'custom', rules: current.rules })).map((finding) => ({ scope: 'current', ...finding })) : []),
    ...(candidate ? (await lintPolicyConfig({ mode: 'custom', rules: candidate.rules })).map((finding) => ({ scope: 'candidate', ...finding })) : []),
  ];
  if (registry.getCurrent() !== current || registry.getCandidate() !== candidate) {
    context.print('[policy] Policy bundles changed while lint was running. Run `/policy lint` again.');
    return;
  }
  if (findings.length === 0) {
    context.print('[policy] No lint findings for the active or candidate bundles.');
    return;
  }
  context.print(`[policy] Lint findings (${findings.length}):`);
  for (const finding of findings) {
    context.print(`  [${finding.scope}] ${finding.severity.toUpperCase()} ${finding.ruleId ? `${finding.ruleId}: ` : ''}${finding.message}`);
  }
}

async function handlePreflight(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  const lintFindings = await policyState.refreshLint(registry);
  if (registry.getCurrent() !== current || registry.getCandidate() !== candidate) {
    context.print('[policy] Policy bundles changed while preflight was running. Run `/policy preflight` again.');
    return;
  }
  const review = buildPolicyPreflightReview({
    config: context.config(),
    lintFindings,
    mcpServers: context.listMcpServerSecurity().map((server) => ({
      serverName: server.name,
      trustMode: server.trustMode,
      role: server.role,
      allowedPaths: server.allowedPaths,
      allowedHosts: server.allowedHosts,
    })),
  });
  policyState.recordPreflightReview(review);
  context.print(`[policy] Preflight review: ${review.status.toUpperCase()} (${review.issueCount} issue${review.issueCount === 1 ? '' : 's'})`);
  context.print(`[policy] ${review.summary}`);
  for (const issue of review.issues.slice(0, 8)) {
    const subject = issue.serverName ? ` ${issue.serverName}` : '';
    const detail = issue.detail ? `: ${issue.detail}` : '';
    context.print(`  [${issue.severity.toUpperCase()}] ${issue.source}${subject}: ${issue.message}${detail}`);
  }
}

async function handlePromote(args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const force = args.includes('--force');
  if (force) {
    context.print('[policy] WARNING: --force bypasses the divergence gate. This is not safe for production use.');
  }
  const result = registry.promote(force);
  if (!result.ok) {
    // Thrown, not printed: the caller (the transcript, or the Policy modal's
    // status line) shows the refusal instead of reporting the command done.
    const gate = result.gate
      ? ` Gate ${result.gate.status}: divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} (threshold ${fmtRate(result.gate.threshold)}, ${result.gate.totalEvaluations} evaluations).`
      : '';
    throw new RefusalError(refusal({
      code: 'POLICY_PROMOTION_BLOCKED',
      state: 'the active enforcement policy is unchanged',
      reason: `Promotion blocked: ${result.error}.${gate}`,
      next: result.gate
        ? ['Run /policy simulate to collect more evaluations, then promote again; /policy promote --force bypasses the gate.']
        : ['Run /policy status to see the candidate bundle, then promote again.'],
    }));
  }
  const current = registry.getCurrent();
  context.print(`[policy] Promoted: "${result.bundleId}" is now the active enforcement policy.`);
  if (result.notice) context.print(`[policy] ${result.notice}`);
  if (result.gate) {
    context.print(`[policy] Gate at promotion: ${result.gate.status}; divergence rate ${result.gate.divergenceRate !== undefined ? fmtRate(result.gate.divergenceRate) : 'unknown'} (threshold ${fmtRate(result.gate.threshold)}).`);
  }
  if (current) context.print(bundleSummary('[policy] Active bundle', current));
  policyState.notify();
  await refreshLintAfterPolicyChange(context);
}

async function handleRollback(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const result = registry.rollback();
  if (!result.ok) {
    throw new RefusalError(refusal({
      code: 'POLICY_ROLLBACK_FAILED',
      state: 'the active enforcement policy is unchanged',
      reason: `Rollback failed: ${result.error}`,
      next: ['Run /policy status to see the bundle history.'],
    }));
  }
  const current = registry.getCurrent();
  context.print(`[policy] Rolled back to bundle "${result.restoredBundleId}".`);
  if (result.notice) context.print(`[policy] ${result.notice}`);
  if (current) context.print(bundleSummary('[policy] Active bundle', current));
  policyState.setDashboard(null);
  policyState.notify();
  context.print('[policy] Simulation dashboard cleared. Run `/policy simulate` for the restored bundle.');
  await refreshLintAfterPolicyChange(context);
}

async function handleStatus(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const current = registry.getCurrent();
  const candidate = registry.getCandidate();
  const history = registry.getHistory();
  const bundleFailure = policyState.getConfiguredBundleFailure();
  if (bundleFailure !== null) {
    context.print(`[policy] The configured policy bundle did not load: ${bundleFailure}. Fix the bundle file and restart or run \`/policy load\`; until then it is not enforced.`);
  }
  if (!current && !candidate) {
    context.print('[policy] No policy bundles loaded. Use `/policy load` to begin.');
    return;
  }
  if (current) context.print(bundleSummary('[policy] Current (enforced)', current));
  if (candidate) context.print(bundleSummary('[policy] Candidate', candidate));
  context.print(`[policy] History: ${history.length} previous bundle(s).`);
  const dashboard = policyState.getDashboard();
  if (dashboard) {
    const snap = dashboard.getSnapshot();
    context.print(`[policy] Divergence gate: ${snap.gate.status}; ${snap.gate.divergenceRate !== undefined ? fmtRate(snap.gate.divergenceRate) : fmtRate(snap.report.overall.divergenceRate)} (${snap.report.overall.totalEvaluations} evaluations).`);
  } else {
    context.print('[policy] No active simulation dashboard.');
  }
}

export function renderPolicyUsage(): string {
  return [
    'Usage: /policy <subcommand>',
    '  /policy                        — open the policy/governance modal',
    '  load <bundle-file>            — Load a candidate bundle from a JSON file',
    '  simulate [mode]               — Run simulation (silent|warn|enforce)',
    '  diff                          — Show rule diff (current vs candidate)',
    '  lint                          — Lint active and candidate bundles',
    '  preflight                     — Review proactive policy and MCP risk state',
    '  promote [--force]             — Promote candidate to enforcement',
    '  rollback                      — Restore the previous active bundle',
    '  status                        — Show current policy state',
  ].join('\n');
}

// Command-path parity: the policy modal dropped its 'r' (record a
// divergence-dashboard trend sample) action because the panel used to call
// this._state.recordTrendEntry() directly and /policy had no equivalent verb.
// This exposes it as a thin wrapper: recordTrendEntry() forwards to the attached
// DivergencePanel, so it only captures a sample while a simulation dashboard is
// active, reported honestly here rather than silently no-op'ing.
function handleRecordTrend(_args: string[], context: PolicyCommandContext): void {
  const policyState = getPolicyState(context);
  if (!policyState.getDashboard()) {
    context.print('[policy] No active simulation dashboard; nothing to sample. Run `/policy simulate` first, then `/policy record-trend`.');
    return;
  }
  policyState.recordTrendEntry();
  const snap = policyState.getSnapshot();
  context.print(`[policy] Recorded a divergence trend sample (${snap.divergence?.trend.length ?? 0} point(s) total).`);
}

export async function dispatchPolicyCommand(args: readonly string[], context: PolicyCommandContext): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'load':
      await handleLoad(rest, context);
      break;
    case 'simulate':
    case 'sim':
      await handleSimulate(rest, context);
      break;
    case 'diff':
      await handleDiff(rest, context);
      break;
    case 'lint':
      await handleLint(rest, context);
      break;
    case 'preflight':
    case 'pf':
      await handlePreflight(rest, context);
      break;
    case 'promote':
      await handlePromote(rest, context);
      break;
    case 'rollback':
    case 'rb':
      await handleRollback(rest, context);
      break;
    case 'status':
    case 'st':
      await handleStatus(rest, context);
      break;
    case 'record-trend':
    case 'trend':
      handleRecordTrend(rest, context);
      break;
    default:
      context.print(renderPolicyUsage());
      break;
  }
}
