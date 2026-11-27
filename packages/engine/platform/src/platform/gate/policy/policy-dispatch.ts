/**
 * The versioned policy-bundle workflow `/security` runs, as engine logic: load a
 * candidate, see what it changes (the rule diff and the recorded calls it
 * decides differently), lint, preflight, promote, roll back, report status.
 *
 * Hoisted from the TUI (src/input/commands/policy-dispatch.ts). The product
 * keeps its command registration and hands this module a narrow context: a
 * print sink, the policy runtime state (and registry, when the product holds
 * its own), and getters for the working directory, the live config and the
 * MCP servers' security records. Every printed line is unchanged.
 *
 * Promotion has no threshold: a bundle exists to decide differently. The
 * operator sees what it changes on this installation's recorded calls and
 * confirms that list with `promote --yes`.
 */
import { contentDigest } from '../../utils/target-ref.js';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { summarizeError } from '../../utils/error-display.js';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { isAbortError } from '../../contract/run-context.js';
import type { DeepReadonly } from '../../config/manager.js';
import type { GoodVibesConfig } from '../../config/schema-types.js';
import {
  buildPolicyPreflightReview,
  lintPolicyConfig,
} from '../../runtime/permissions/index.js';
import { policyImpact, type PolicyImpact } from '../../runtime/permissions/policy-impact.js';
import type { PolicyBundlePayload } from '../../runtime/permissions/policy-loader.js';
import type { PolicyBundleVersion, PolicyRegistry } from '../../runtime/permissions/policy-registry.js';
import type { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.js';
import type { PolicyPreflightServer } from '../../runtime/permissions/preflight.js';
import type { SignedPolicyBundle } from '../../runtime/permissions/policy-signer.js';

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
  /** The project root the simulation evaluates against (may throw when unavailable). */
  workingDirectory(): string;
  /** The live config: the preflight review reads it, and simulate reads the divergence threshold. */
  config(): DeepReadonly<GoodVibesConfig>;
  /** The MCP servers' security records the preflight review reads. */
  listMcpServerSecurity(): readonly PolicyMcpServerSecurity[];
  /**
   * Who asks, when it is not the owner: whether it may reach a project's things (control-plane/caller-reach.ts, by the
   * folder; undefined, a thing of no project). Such a caller sees a candidate only when it was loaded from a project it
   * may reach, and its preview decides again only the recorded calls of projects it may reach, without reviewing the
   * candidate for the owner (its state, its kept impact). Absent: the owner, who sees and reviews everything.
   */
  readonly reach?: ((project: string | undefined) => boolean) | undefined;
}

/** The candidate as the asker may see it: the owner every one; anyone else one loaded from a project it may reach. */
function visibleCandidate(context: PolicyCommandContext, registry: PolicyRegistry): ReturnType<PolicyRegistry['getCandidate']> {
  const candidate = registry.getCandidate();
  if (!candidate || !context.reach) return candidate;
  return candidate.sourcePath && context.reach(dirname(candidate.sourcePath)) ? candidate : null;
}

function getPolicyState(ctx?: PolicyCommandContext): PolicyRuntimeState {
  const policyRuntimeState = ctx?.policyRuntimeState;
  if (!policyRuntimeState) {
    throw new Error('Policy runtime state is not available in this runtime.');
  }
  return policyRuntimeState;
}

function getRegistry(ctx?: PolicyCommandContext): PolicyRegistry {
  return getPolicyState(ctx).getRegistry();
}

async function refreshLintAfterPolicyChange(context: PolicyCommandContext): Promise<void> {
  try {
    await getPolicyState(context).refreshLint(getRegistry(context));
  } catch (error) {
    context.print(`[policy] Policy change applied, but lint findings could not be refreshed: ${summarizeError(error)}`);
  }
}

/** A bundle's state in the words a person reads. */
const BUNDLE_STATE_WORDS: Readonly<Record<string, string>> = {
  loaded: 'not reviewed yet',
  simulating: 'being reviewed',
  promoting: 'reviewed, ready to enforce',
  active: 'in force',
  superseded: 'replaced',
  'rolled-back': 'set aside',
};

function bundleSummary(
  label: string,
  version: PolicyBundleVersion,
): string {
  const issuer = version.bundle.issuer ? ` by ${version.bundle.issuer}` : '';
  const ts = version.bundle.issuedAt.replace('T', ' ').slice(0, 16);
  const rules = `${version.rules.length} rule${version.rules.length === 1 ? '' : 's'}`;
  const state = BUNDLE_STATE_WORDS[version.state] ?? version.state;
  return `${label}: ${version.bundle.bundleId}, issued ${ts}${issuer}, ${rules}, ${state}.`;
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
    context.print('[policy] Nothing was loaded: name the bundle file to load.');
    return;
  }
  let bundle: SignedPolicyBundle<PolicyBundlePayload>;
  try {
    bundle = readBundleFile(file, context.workingDirectory());
  } catch (error) {
    context.print(`[policy] Load failed, the current and candidate bundles are unchanged: ${summarizeError(error)}`);
    return;
  }
  // The file is kept with the candidate, so the activation record names it and a restart reads this bundle.
  const result = registry.loadCandidate(bundle, { sourcePath: resolve(context.workingDirectory(), file) });
  if (!result.ok) {
    context.print(`[policy] Load failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  const candidate = registry.getCandidate();
  if (candidate) {
    policyState.notify();
    context.print(bundleSummary('[policy] Candidate loaded', candidate));
    context.print('[policy] Next: "See what the candidate policy changes" shows which recorded calls it would decide differently; then "Enforce the candidate policy".');
    await refreshLintAfterPolicyChange(context);
  }
}

/** The impact list as the operator reads it: each recorded call the candidate decides differently. */
function printImpact(context: PolicyCommandContext, impact: PolicyImpact): void {
  context.print(`[policy] Recorded calls decided again: ${impact.checkedCalls}${impact.skippedCalls ? ` (${impact.skippedCalls} without a target skipped)` : ''}; the candidate decides ${impact.changed.length} differently.`);
  for (const call of impact.changed.slice(0, 50)) {
    context.print(`      ${call.before} -> ${call.after}  ${call.tool} ${call.target}${call.rule ? `  (${call.rule})` : ''}`);
  }
  if (impact.changed.length > 50) context.print(`      ... and ${impact.changed.length - 50} more`);
}

/**
 * Shows what promoting the candidate would change: the rule diff and the calls
 * this installation's permission audit recorded that it decides differently,
 * decided again by code with no model request. Promotion then confirms it.
 */
/**
 * Per registry, the digest of the candidate `/security simulate-policy` last showed:
 * `/security enforce-policy` enforces only that candidate, never one loaded since.
 */
const simulatedCandidates = new WeakMap<object, string>();

/** The candidate's identity: its rules, its bundle and when it was loaded. */
function candidateDigest(candidate: { readonly rules: unknown; readonly bundle: unknown; readonly loadedAt: string }): string {
  return contentDigest({ rules: candidate.rules, bundle: candidate.bundle, loadedAt: candidate.loadedAt });
}

async function handleSimulate(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const candidate = visibleCandidate(context, registry);
  const current = registry.getCurrent();
  if (!candidate) {
    context.print('[policy] No candidate policy is loaded: "Load a candidate policy" first.');
    return;
  }
  // A caller that is not the owner sees what the candidate changes of the calls it may reach, each decided against its
  // own project; the owner's review of the candidate (its state, its kept impact, what enforcing confirms) is untouched.
  if (context.reach) {
    const reached = policyImpact({
      currentRules: current?.rules ?? [], candidateRules: candidate.rules,
      projectRoot: context.workingDirectory(), calls: policyState.getRecentPermissionAudit(), reaches: context.reach,
    });
    await handleDiff([], context);
    printImpact(context, reached);
    return;
  }
  if (!registry.markSimulating()) {
    const reason = registry.describeCandidateRefusal('simulating') ?? `Candidate is in "${candidate.state}" state`;
    context.print(`[policy] Cannot review the candidate: ${reason}.`);
    return;
  }
  let impact: PolicyImpact;
  try {
    impact = policyImpact({
      currentRules: current?.rules ?? [], candidateRules: candidate.rules,
      projectRoot: context.workingDirectory(), calls: policyState.getRecentPermissionAudit(),
    });
  } catch (error) {
    registry.abandonSimulation();
    policyState.notify();
    if (isAbortError(error)) throw error;
    context.print(`[policy] Review failed: ${summarizeError(error)}. The candidate is back in "loaded" state; review it again with "See what the candidate policy changes".`);
    return;
  }
  registry.attachImpact(impact);
  simulatedCandidates.set(registry, candidateDigest(candidate));
  policyState.recordSimulationSummary({
    simulatedAt: new Date().toISOString(), mode: 'simulation-only',
    totalScenarios: impact.checkedCalls, divergentScenarios: impact.changed.length,
    allowedByActual: impact.changed.filter((call) => call.before === 'allow').length,
    allowedBySimulated: impact.changed.filter((call) => call.after === 'allow').length,
    results: [],
  });
  policyState.notify();
  await handleDiff([], context);
  printImpact(context, impact);
  context.print('[policy] "Enforce the candidate policy" enforces it with these changes.');
  const reviewed = registry.getCandidate();
  if (reviewed) context.print(bundleSummary('[policy] Candidate state', reviewed));
}

async function handleDiff(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const diff = visibleCandidate(context, registry) ? registry.diff() : null;
  if (!diff) {
    const current = registry.getCurrent();
    const candidate = visibleCandidate(context, registry);
    if (!current) context.print(candidate
      ? `[policy] No policy is in force yet: ${candidate.rules.length === 1 ? 'the one rule' : `all ${candidate.rules.length} rules`} of the candidate would be new.`
      : '[policy] No policy is in force and none is loaded: "Load a candidate policy" first.');
    else if (!candidate) context.print('[policy] No candidate policy is loaded: "Load a candidate policy" first.');
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
  }  if (diff.moved.length > 0) {
    context.print('  [>] Moved rules (rules are read in order, so a move can change which one decides):');
    for (const m of diff.moved) context.print(`      > ${m.ruleId}: position ${m.from + 1} -> ${m.to + 1}`);
  }
  if (diff.duplicateIds.length > 0) {
    context.print('  [!] Ids used by more than one rule (each copy is compared at its own position):');
    for (const d of diff.duplicateIds) context.print(`      ! ${d.ruleId}: ${d.count} rules in the ${d.bundle === 'from' ? 'active' : 'candidate'} bundle`);
  }
}

async function handleLint(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const current = registry.getCurrent();
  const candidate = visibleCandidate(context, registry);
  if (!current && !candidate) {
    context.print('[policy] No policy is loaded: "Load a candidate policy" to begin.');
    return;
  }
  const findings = [
    ...(current ? (await lintPolicyConfig({ mode: 'custom', rules: current.rules })).map((finding) => ({ scope: 'current', ...finding })) : []),
    ...(candidate ? (await lintPolicyConfig({ mode: 'custom', rules: candidate.rules })).map((finding) => ({ scope: 'candidate', ...finding })) : []),
  ];
  if (registry.getCurrent() !== current || visibleCandidate(context, registry) !== candidate) {
    context.print('[policy] The policies changed while they were being checked; check them again.');
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
  // A caller that is not the owner: the bundles it may see only (a candidate of a project it may not reach is neither
  // read nor counted), and its review is its own, never kept as the owner's.
  const lintFindings = context.reach
    ? [...(current ? await lintPolicyConfig({ mode: 'custom', rules: current.rules }) : []),
      ...(candidate && visibleCandidate(context, registry) === candidate ? await lintPolicyConfig({ mode: 'custom', rules: candidate.rules }) : [])]
    : await policyState.refreshLint(registry);
  if (registry.getCurrent() !== current || registry.getCandidate() !== candidate) {
    context.print('[policy] The policies changed while they were being reviewed; review them again.');
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
  if (!context.reach) policyState.recordPreflightReview(review);
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
  const candidate = registry.getCandidate();
  // Promotion is the operator's confirmation of the list `/security simulate-policy` showed.
  if (candidate?.state === 'promoting' && !args.includes('--yes')) {
    if (candidate.impact) printImpact(context, candidate.impact);
    context.print('[policy] Not enforced yet: "Enforce the candidate policy" enforces it with the changes above.');
    return;
  }
  // The candidate enforced is the one simulate showed: a candidate loaded or changed since is refused.
  if (candidate && simulatedCandidates.get(registry) !== candidateDigest(candidate)) {
    throw new RefusalError(refusal({
      code: 'POLICY_PROMOTION_BLOCKED',
      state: 'the active enforcement policy is unchanged',
      reason: 'Not enforced: the candidate is not the one "See what the candidate policy changes" showed (it was loaded or changed since, or never reviewed)',
      next: ['"See what the candidate policy changes" shows its changes; then "Enforce the candidate policy".'],
    }));
  }
  const result = registry.promote();
  if (!result.ok) {
    // Thrown, not printed: the caller (the place's outcome line, a script, a model) shows the refusal instead of reporting it done.
    throw new RefusalError(refusal({
      code: 'POLICY_PROMOTION_BLOCKED',
      state: 'the active enforcement policy is unchanged',
      reason: `Not enforced: ${result.error}`,
      next: ['"See what the candidate policy changes" shows what the candidate changes; then "Enforce the candidate policy".'],
    }));
  }
  const current = registry.getCurrent();
  context.print(`[policy] Enforced: "${result.bundleId}" is the policy in force now, in every program on this machine.`);
  if (result.notice) context.print(`[policy] ${result.notice}`);
  if (result.impact) context.print(`[policy] Confirmed changes: ${result.impact.changed.length} recorded call(s) now decided differently.`);
  if (current) context.print(bundleSummary('[policy] In force now', current));
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
      reason: `Nothing was restored: ${result.error}`,
      next: ['"See the policy in force" shows the history.'],
    }));
  }
  const current = registry.getCurrent();
  context.print(`[policy] Restored: "${result.restoredBundleId}" is the policy in force again, in every program on this machine.`);
  if (result.notice) context.print(`[policy] ${result.notice}`);
  if (current) context.print(bundleSummary('[policy] In force now', current));
  policyState.notify();
  await refreshLintAfterPolicyChange(context);
}

async function handleStatus(_args: string[], context: PolicyCommandContext): Promise<void> {
  const registry = getRegistry(context);
  const policyState = getPolicyState(context);
  const current = registry.getCurrent();
  const candidate = visibleCandidate(context, registry);
  const history = registry.getHistory();
  const bundleFailure = policyState.getConfiguredBundleFailure();
  if (bundleFailure !== null) {
    context.print(`[policy] The configured policy bundle did not load: ${bundleFailure}. Fix the bundle file and restart, or "Load a candidate policy"; until then it is not enforced.`);
  }
  if (!current && !candidate) {
    context.print('[policy] No policy is loaded: "Load a candidate policy" to begin.');
    return;
  }
  if (current) context.print(bundleSummary('[policy] In force', current));
  if (candidate) context.print(bundleSummary('[policy] Candidate', candidate));
  context.print(`[policy] History: ${history.length} previous bundle(s).`);
  if (!candidate?.impact) return;
  // A caller that is not the owner: the owner's review counted every project's recorded calls, and a count is
  // information about the projects too, so its calls of the projects it may reach are decided again for it (code, no
  // model request), counted and listed like its rows.
  printImpact(context, context.reach
    ? policyImpact({ currentRules: current?.rules ?? [], candidateRules: candidate.rules, projectRoot: candidate.sourcePath ? dirname(candidate.sourcePath) : context.workingDirectory(),
      calls: policyState.getRecentPermissionAudit(), reaches: context.reach })
    : candidate.impact);
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
    default:
      throw new RefusalError(refusal({
        code: 'USAGE',
        state: 'nothing was changed',
        reason: `The policy workflow has no step "${sub ?? ''}".`,
        next: ['Permissions and safety, Policy, lists the policy actions.'],
      }));
  }
}
