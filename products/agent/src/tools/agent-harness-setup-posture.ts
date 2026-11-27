import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { rankStatefulCatalog } from './agent-harness-stateful-catalog-source.ts';
import { readAgentHostPairing } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-pairing-store';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import { join } from 'node:path';
import { getOrCreateCompanionToken } from '@goodvibes/engine/platform/platform/pairing';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { deriveStep1Capabilities, deriveStep1CapabilityFlags } from '../runtime/onboarding/index.ts';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-auth';
import { SETUP_TOPICS } from '@goodvibes/engine/terminal-shell/setup-command';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import type { SetupSmokeNativeEvidence } from './agent-setup-smoke-reference.ts';
import { DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE, DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE } from '../agent/setup-wizard.ts';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { captureCatalogSnapshot } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-data';
import { type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import type { AgentHarnessSetupArgs, SetupResolution } from './agent-harness-setup-posture-types.ts';
import { buildSetupPlan, SETUP_PLAN_ROW_IDS } from './agent-harness-setup-plan.ts';
import { buildSetupWizard, describeInstallSmokeCheck, ignoredSetupSmokeEvidenceFields, installSmokeNextAction, SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS, installSmokeRunResult, installSmokeRunSummary, latestSetupSmokeEvidence, saveSetupSmokeArtifact, setupCompletionMarkerExists, setupSmokeEvidenceArtifacts, setupSmokeEvidenceHistory } from './agent-harness-setup-smoke.ts';
import { confirmedRepairCandidates, describeCandidate, describeHandoffCard, describeItem, describePlanItem, describeRepairCard, describeRepairDecision, describeServiceLifecycleDecision, nextSetupHandoffSummaries, planSummary, primarySetupRepairDecision, setupRepairTarget } from './agent-harness-setup-describe.ts';
import { setupHandoffsForItem } from './agent-harness-setup-handoffs.ts';
import { homeRelativePath } from '@goodvibes/engine/terminal-shell/agent-turn/home-path';
import type { EffectResult } from './agent-harness-tool-utils.ts';
import { collectServicePosture, collectSnapshot, lookupFromArgs, quoteRouteValue, readLimit, readString, safeFileMode, safeIso, summarizeLocalBehavior } from './agent-harness-setup-posture-utils.ts';

/**
 * A setup read is correct for the moment it was taken (it carries
 * `capturedAt`); the next read corrects a stale one. So a call checks only
 * that it is still wanted (its signal and its caller), never re-reads its
 * sources.
 */
function captureSetupCaller<T>(_context: CommandContext, args: T, options: CatalogRankingOptions) {
  const caller = captureAsyncHarnessInput(args, options, true);
  return { ...caller,
    publish<R>(result: R): R { caller.retainSourceCurrent('agent.setup.sources'); return result; },
  };
}

/** One observation per setup call: snapshot, capabilities, saved smoke evidence (one listing) and the plan. */
async function observeSetup(context: CommandContext, options: CatalogRankingOptions, only?: ReadonlySet<string>,
  observed?: Awaited<ReturnType<typeof collectSnapshot>>) {
  const snapshot = observed ?? await collectSnapshot(context, options);
  const capabilities = deriveStep1Capabilities(snapshot);
  let probe: Promise<Awaited<ReturnType<typeof collectServicePosture>>> | undefined;
  const probeServices = () => probe ??= collectServicePosture(context, { signal: options.signal, assertCurrent: options.assertCurrent ?? (() => {}) });
  const smoke = setupSmokeEvidenceArtifacts(context);
  const plan = await buildSetupPlan(context, { snapshot, capabilities, probeServices, smoke }, options, only);
  return { snapshot, capabilities, smoke, plan };
}

export async function setupPostureCatalogStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const caller = captureSetupCaller(context, {}, options);
  const { snapshot, capabilities, smoke, plan } = await observeSetup(context, caller.options);
  caller.assertCurrent();
  const setupSmokeEvidence = latestSetupSmokeEvidence(smoke);
  const setupSmokeHistory = setupSmokeEvidenceHistory(smoke);
  const setupWizard = buildSetupWizard(plan, context, smoke);
  return caller.publish({
    modes: ['setup_posture', 'setup_item', 'setup_repair', 'provision_connected_host_token', 'run_setup_smoke'],
    // What the person sets up, one topic at a time: each a row of System's Setup tab and the capability setup.<topic>
    // (a provider of your own is Models and providers' provider.add).
    setupTopics: Object.values(SETUP_TOPICS).map((topic) => (topic.word === 'add-provider'
      ? { label: topic.label, control: 'Models and providers, n', capability: 'provider.add' }
      : { label: topic.label, control: 'System, Setup', capability: `setup.${topic.word}` })),
    capabilities: capabilities.length,
    planItems: plan.length,
    blockedPlanItems: plan.filter((item) => item.status === 'blocked').length,
    autonomyBlockers: plan.filter((item) => item.blocksAutonomy && item.status !== 'ready').length,
    nextSetupHandoffs: nextSetupHandoffSummaries(plan, 5),
    setupWizard,
    setupCloseout: setupWizard._diagnostic.closeout,
    collectionIssues: snapshot.collectionIssues.length,
    setupMarkerExists: setupCompletionMarkerExists(context),
    setupSmokeEvidence,
    setupSmokeHistory,
    readOnly: true,
  });
}

export async function setupRepairSummary(context: CommandContext, rawArgs: AgentHarnessSetupArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const caller = captureSetupCaller(context, rawArgs, options), args = caller.args;
  const { snapshot, smoke, plan } = await observeSetup(context, caller.options);
  caller.assertCurrent();
  const setupWizard = buildSetupWizard(plan, context, smoke);
  const includeParameters = args.includeParameters === true;
  const target = await setupRepairTarget(plan, setupWizard, args, caller.options);
  caller.assertCurrent();
  if ('error' in target) return caller.publish(target.error);

  const item = target.item;
  const decision = primarySetupRepairDecision(item);
  const handoffs = setupHandoffsForItem(item);
  const alternatives = handoffs
    .filter((handoff) => handoff.id !== decision.id)
    .slice(0, includeParameters ? 8 : 3)
    .map((handoff) => describeHandoffCard(handoff, includeParameters));
  const confirmedCandidates = confirmedRepairCandidates(item);
  return caller.publish({
    mode: 'setup_repair',
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    setupItemId: item.id,
    label: item.label,
    status: item.status,
    blocksAutonomy: item.blocksAutonomy,
    lookup: target.lookup,
    decision: describeRepairDecision(decision, includeParameters),
    nextAction: previewHarnessText(item.nextAction, includeParameters ? 220 : 140),
    userRoute: previewHarnessText(item.userRoute, includeParameters ? 160 : 120),
    modelRoute: item.modelRoute,
    alternatives,
    ...(confirmedCandidates.length > 0 ? {
      possibleConfirmedRepairs: confirmedCandidates.map((candidate) => describeRepairDecision(candidate, includeParameters)),
    } : {}),
    ...(item.serviceProbe ? { serviceProbe: item.serviceProbe } : {}),
    ...(item.serviceLifecycleDecision ? { serviceLifecycleDecision: describeServiceLifecycleDecision(item.serviceLifecycleDecision) } : {}),
    ...(includeParameters && item.repairCards ? { repairCards: item.repairCards.map(describeRepairCard) } : {}),
    ...(includeParameters && item.bootstrapPlan ? { bootstrapPlan: item.bootstrapPlan } : {}),
    ...(includeParameters && item.authPosture ? { authPosture: item.authPosture } : {}),
    setupWizard: {
      status: setupWizard.status,
      currentStepId: setupWizard.currentStepId,
      currentStepLabel: setupWizard.currentStepLabel,
      closeout: setupWizard._diagnostic.closeout,
    },
    routes: {
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      inspectItem: `setup action:"item" setupItemId:"${quoteRouteValue(item.id)}" includeParameters:true`,
      rerunRepair: `setup action:"repair" setupItemId:"${quoteRouteValue(item.id)}" includeParameters:true`,
    },
    policy: {
      effect: 'read-only-repair-decision',
      boundary: 'This route chooses the safest next setup repair route only. It never starts, installs, restarts, writes tokens, imports settings, or opens UI by itself.',
      confirmation: 'Any returned confirmed-effect route runs only under current recorded effect admission (a visible approval from the person). confirm:true and explicitUserRequest are context and grant nothing.',
      hostOwnership: 'GoodVibes Agent does not take ambient ownership of the GoodVibes host lifecycle. At boot it starts an installed-but-stopped host once through the platform service manager and reports it; beyond that, disconnected hosts use user-run bootstrap guidance, and reachable hosts use daemon receipts before lifecycle mutation.',
    },
  });
}

export async function setupPostureSummary(context: CommandContext, rawArgs: AgentHarnessSetupArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const caller = captureSetupCaller(context, rawArgs, options), args = caller.args;
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const { snapshot, capabilities: all, smoke, plan } = await observeSetup(context, caller.options);
  caller.assertCurrent();
  const setupSmokeEvidence = latestSetupSmokeEvidence(smoke);
  const setupSmokeHistory = setupSmokeEvidenceHistory(smoke);
  const setupWizard = buildSetupWizard(plan, context, smoke);
  const servicePosture = plan.find((item) => item.id === 'connected-host-readiness')?.serviceProbe ?? null;
  // These two capture times are created by the native snapshot collectors.
  // Keep the complete original observation bound while expressing its clocks
  // as ISO timestamps; an epoch can coincidentally satisfy the card checksum.
  const nativeSnapshot = captureCatalogSnapshot(snapshot);
  caller.options.retainCurrent(() => nativeSnapshot.assertCurrent(snapshot), 'agent.setup.ranking-snapshot');
  const observed = nativeSnapshot.captured;
  const rankingSnapshot = { ...observed, capturedAt: new Date(observed.capturedAt).toISOString(),
    providerAccounts: observed.providerAccounts === null ? null : { ...observed.providerAccounts,
      capturedAt: new Date(observed.providerAccounts.capturedAt).toISOString() } };
  const rankingContext = { snapshot: rankingSnapshot, servicePosture, setupWizard, capabilities: all, plan, args };
  const ranked = query ? await rankStatefulCatalog(all, query, item => ({ id: item.id, description: item.label }), 'agent.setup.capabilities', caller.options, rankingContext) : all;
  caller.assertCurrent();
  const rankedPlan = query ? await rankStatefulCatalog(plan, query, item => ({ id: item.id, description: item.label }), 'agent.setup.plan', caller.options, rankingContext) : plan;
  caller.assertCurrent();
  const filtered = ranked.slice(0, readLimit(args.limit, 100));
  const filteredPlan = rankedPlan.slice(0, readLimit(args.limit, 100));
  return caller.publish({
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    setupMarker: {
      scope: snapshot.acknowledgements.scope,
      exists: snapshot.acknowledgements.exists,
      completionExists: setupCompletionMarkerExists(context),
      updatedAt: safeIso(snapshot.acknowledgements.updatedAt),
      source: snapshot.acknowledgements.source,
      mode: snapshot.acknowledgements.mode ?? null,
      acceptedCount: Object.values(snapshot.acknowledgements.accepted).filter(Boolean).length,
    },
    summary: {
      capabilities: all.length,
      selectedCapabilities: all.filter((item) => item.selected).length,
      collectionIssues: snapshot.collectionIssues.length,
      services: snapshot.services.total,
      oauthProviders: snapshot.services.oauthProviderIds.length,
      subscriptionSessions: snapshot.subscriptions.active.length,
      pendingSubscriptionSessions: snapshot.subscriptions.pending.length,
      providerAccounts: snapshot.providerAccounts?.providers.length ?? 0,
      providerAccountIssues: snapshot.providerAccounts?.issueCount ?? 0,
      secretsStoredKeys: snapshot.secrets.review.storedKeys,
      secretRecordCount: snapshot.secrets.records.length,
      authUsers: snapshot.auth.snapshot.userCount,
      authSessions: snapshot.auth.snapshot.sessionCount,
      enabledSurfaceKinds: snapshot.surfaces.configuredEnabledKinds.length,
      localBehavior: summarizeLocalBehavior(snapshot),
      capabilityFlags: deriveStep1CapabilityFlags(snapshot),
      readinessPlan: planSummary(plan),
    },
    setupSmokeEvidence,
    setupSmokeHistory,
    setupWizard,
    setupCloseout: setupWizard._diagnostic.closeout,
    currentRoute: snapshot.providerRouting,
    issues: snapshot.collectionIssues,
    readinessPlan: filteredPlan.map((item) => describePlanItem(item, includeParameters)),
    nextSetupActions: nextSetupHandoffSummaries(plan, 5),
    capabilities: filtered.map((item) => describeItem(item, snapshot, { includeParameters })),
    returned: filtered.length,
    total: all.length,
    readinessPlanReturned: filteredPlan.length,
    readinessPlanTotal: plan.length,
    ...(filteredPlan.length < plan.length || filtered.length < all.length
      ? { note: `Partial view: ${filteredPlan.length} of ${plan.length} readiness items and ${filtered.length} of ${all.length} capabilities are shown (limit or query applied; limit is at most 500). A blocked item may be outside this page; call without query and limit to see all.` }
      : {}),
    policy: 'Read-only setup/onboarding posture. Apply, import, auth, profile, channel, and setting mutations remain confirmation-gated through visible workspace, settings, slash-command, or first-class tool flows.',
  });
}

export function provisionConnectedHostOperatorToken(context: CommandContext, args: AgentHarnessSetupArgs): EffectResult {
  const setupItemId = readString(args.setupItemId);
  if (setupItemId && setupItemId !== 'connected-host-auth') {
    return {
      status: 'unsupported_setup_item',
      done: false,
      usage: 'provision_connected_host_token supports setupItemId:"connected-host-auth" only.',
    };
  }

  const shellPaths = requireShellPaths(context);
  const pairing = readAgentHostPairing(shellPaths.homeDirectory, resolveConnectedHostAddress(context.platform.configManager).baseUrl);
  if (pairing.status !== 'missing') return {
    status: 'blocked', done: false, mode: 'provision_connected_host_token', setupItemId: 'connected-host-auth',
    mutation: { performed: false },
    error: 'Agent host-bound pairing already exists or requires review. Review it with capability_run id:"devices.pair" (the owner: Pair something in the Devices and network place); this route will not rewrite shared-token storage to bypass it.',
  };
  const before = readConnectedHostOperatorToken(shellPaths.homeDirectory);
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (before.token && before.path.startsWith('env:')) {
    return {
      status: 'already_usable_env_token',
      done: true,
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      token: {
        path: before.path,
        present: true,
        usable: true,
        rawValueReturned: false,
      },
      mutation: {
        performed: false,
        reason: 'Environment-provided connected-host token is already effective; no local token file was written.',
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
        pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        secrets: 'Raw connected-host tokens are never returned.',
        boundary: 'Environment-provided tokens take precedence and are not modified by this route.',
      },
    };
  }

  const daemonHomeDir = resolveGoodVibesDaemonHome(shellPaths.homeDirectory);
  const canonicalPath = connectedHostOperatorTokenPath(shellPaths.homeDirectory);
  try {
    const record = getOrCreateCompanionToken(GOODVIBES_AGENT_PAIRING_SURFACE, { daemonHomeDir });
    const after = readConnectedHostOperatorToken(shellPaths.homeDirectory);
    if (!after.token) {
      return {
        status: 'failed',
        done: false,
        mode: 'provision_connected_host_token',
        setupItemId: 'connected-host-auth',
        explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
        error: after.error ? previewHarnessText(after.error, 160) : 'platform token provisioning completed but no usable connected-host token was readable.',
        token: {
          path: homeRelativePath(after.path, shellPaths.homeDirectory),
          present: after.present,
          usable: false,
          rawValueReturned: false,
        },
        routes: {
          inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
          inspectStatus: 'host action:"status" includeParameters:true',
        },
      };
    }
    const changed = before.token !== after.token;
    const result = before.token
      ? changed ? 'repaired' : 'already_usable'
      : before.present ? 'repaired' : 'created';
    return {
      status: result,
      done: true,
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      token: {
        path: homeRelativePath(after.path, shellPaths.homeDirectory),
        canonicalPath: homeRelativePath(canonicalPath, shellPaths.homeDirectory),
        present: true,
        usable: true,
        rawValueReturned: false,
        fileMode: safeFileMode(canonicalPath),
      },
      companionRecord: {
        surface: GOODVIBES_AGENT_PAIRING_SURFACE,
        peerId: record.peerId,
        createdAt: safeIso(record.createdAt),
      },
      mutation: {
        performed: result === 'created' || result === 'repaired',
        result,
        existingTokenPreserved: result === 'already_usable',
        source: 'getOrCreateCompanionToken',
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
        pairingPosture: 'agent_harness mode:"pairing_posture" includeParameters:true',
        runSetupSmoke: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        source: 'platform platform pairing helper writes the canonical connected-host operator token file with owner-only permissions.',
        secrets: 'Only path, peer id, and timestamps are returned; the raw token is not returned.',
        rotation: 'This route preserves a valid existing token and only creates or repairs the local canonical file.',
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      done: false,
      mode: 'provision_connected_host_token',
      setupItemId: 'connected-host-auth',
      explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
      error: previewHarnessText(error instanceof Error ? error.message : String(error), 160),
      token: {
        path: homeRelativePath(canonicalPath, shellPaths.homeDirectory),
        present: before.present,
        usable: false,
        rawValueReturned: false,
      },
      routes: {
        inspectAuth: 'setup action:"item" setupItemId:"connected-host-auth"',
        inspectStatus: 'host action:"status" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-local-token-provisioning',
        secrets: 'Raw connected-host tokens are never returned.',
      },
    };
  }
}

export async function runSetupInstallSmoke(context: CommandContext, args: AgentHarnessSetupArgs, ownership: SetupSmokeNativeEvidence, signal?: AbortSignal): Promise<EffectResult> {
  ownership.assertCurrent();
  const setupItemId = readString(args.setupItemId);
  if (setupItemId && setupItemId !== 'install-smoke') {
    return {
      status: 'unsupported_setup_item',
      done: false,
      usage: 'run_setup_smoke currently supports setupItemId:"install-smoke" only.',
    };
  }

  const { snapshot, plan } = await observeSetup(context, { signal, assertCurrent: ownership.assertCurrent }, new Set(['install-smoke']));
  ownership.assertCurrent();
  const installSmoke = plan.find((item) => item.id === 'install-smoke');
  const smokePlan = installSmoke?.installSmokePlan;
  if (!smokePlan) {
    return {
      status: 'missing_smoke_plan',
      done: false,
      usage: 'Install smoke plan is not available. Inspect mode:"setup_posture" for setup readiness.',
    };
  }

  const includeParameters = args.includeParameters === true;
  const summary = installSmokeRunSummary(smokePlan);
  const blockedChecks = smokePlan.checks.filter((check) => check.status === 'blocked').map((check) => check.id);
  const userRunChecks = smokePlan.checks.filter((check) => check.status === 'user-run').map((check) => check.id);
  const capturedAt = new Date(snapshot.capturedAt).toISOString();
  const explicitUserRequest = readString(args.explicitUserRequest);
  const evidenceFields = ownership.fields;
  const artifact = await saveSetupSmokeArtifact({
    context,
    capturedAt,
    explicitUserRequest,
    smokePlan,
    summary,
    blockedChecks,
    userRunChecks,
    evidenceFields,
    ownership,
  });
  // A saved artifact is committed: its answer must reach the caller with the id, so a
  // source change after the save is not checked. A run that saved nothing is still a read.
  if (artifact.status !== 'saved') ownership.assertCurrent();
  const result = installSmokeRunResult(smokePlan, evidenceFields.map((field) => field.id));
  const ignoredFields = ignoredSetupSmokeEvidenceFields(args.fields);
  return {
    // Nothing is executed here: the plan is read and a snapshot saved, so the
    // top-level status names what the snapshot found and `done` says whether the evidence was saved.
    status: result,
    done: artifact.status === 'saved',
    mode: 'run_setup_smoke',
    setupItemId: 'install-smoke',
    capturedAt,
    smokeStatus: smokePlan.status,
    result,
    explicitUserRequest: previewHarnessText(explicitUserRequest, 160),
    summary,
    blockedChecks,
    userRunChecks,
    checks: smokePlan.checks.map((check) => describeInstallSmokeCheck(check, includeParameters)),
    artifact,
    ...(ignoredFields.length > 0 ? { ignoredFields, ignoredFieldsNote: `Only these evidence fields are saved: ${SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS.map((definition) => definition.id).join(', ')}.` } : {}),
    successCriteria: includeParameters ? smokePlan.successCriteria : smokePlan.successCriteria.map((entry) => previewHarnessText(entry, 120)),
    nextAction: installSmokeNextAction(smokePlan),
    routes: {
      inspectSetup: DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
      inspectSmoke: 'setup action:"item" setupItemId:"install-smoke"',
      rerunSmoke: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
      saveEvidence: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
    },
    policy: {
      effect: 'confirmed-redacted-setup-smoke',
      shell: 'No package, host, or shell commands were executed implicitly.',
      secrets: 'Secrets and connected-host tokens are never returned; token evidence remains presence and path only.',
      source: smokePlan.policy,
    },
    source: smokePlan.source,
  };
}

export async function describeHarnessSetupItem(context: CommandContext, rawArgs: AgentHarnessSetupArgs, options: CatalogRankingOptions = {}): Promise<SetupResolution> {
  const caller = captureSetupCaller(context, rawArgs, options), args = caller.args;
  const publish = (result: SetupResolution): SetupResolution => {
    caller.retainSourceCurrent('agent.setup.item.sources');
    return result;
  };
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return publish({
      status: 'missing_lookup',
      usage: 'setup_item requires setupItemId, target, or query. Use mode:"setup_posture" to inspect setup item ids.',
    });
  }
  const normalized = lookup.input.toLowerCase();
  // An exact plan row id builds that row alone: the host is probed only for a row that reports it.
  const planId = SETUP_PLAN_ROW_IDS.find((id) => id === lookup.input) ?? SETUP_PLAN_ROW_IDS.find((id) => id === normalized);
  const snapshot = await collectSnapshot(context, caller.options);
  caller.assertCurrent();
  const items = deriveStep1Capabilities(snapshot);
  const exact = items.find((item) => item.id === lookup.input);
  if (exact) return publish({ status: 'found', item: describeItem(exact, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) });
  if (planId) {
    const { plan: rows } = await observeSetup(context, caller.options, new Set([planId]), snapshot);
    caller.assertCurrent();
    const row = rows[0];
    if (row) return publish({ status: 'found', item: { ...describePlanItem(row, true), lookup: { ...lookup, resolvedBy: planId === lookup.input ? 'plan-id' : 'case-insensitive-plan-id' } } });
  }
  const { plan } = await observeSetup(context, caller.options, undefined, snapshot);
  caller.assertCurrent();
  const insensitive = items.find((item) => item.id.toLowerCase() === normalized);
  if (insensitive) return publish({ status: 'found', item: describeItem(insensitive, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) });
  const insensitivePlan = plan.find((item) => item.id.toLowerCase() === normalized);
  if (insensitivePlan) return publish({ status: 'found', item: { ...describePlanItem(insensitivePlan, true), lookup: { ...lookup, resolvedBy: 'case-insensitive-plan-id' } } });
  const entries = [
    ...items.map(item => ({ kind: 'capability' as const, item })),
    ...plan.map(item => ({ kind: 'plan' as const, item })),
  ];
  const selected = await selectHarnessCatalog(entries, lookup.input, entry => ({ id: `${entry.kind}:${entry.item.id}`, description: entry.item.label }), caller.options, 'agent.setup.item');
  caller.assertCurrent();
  if (selected?.kind === 'capability') return publish({ status: 'found', item: describeItem(selected.item, snapshot, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) });
  if (selected?.kind === 'plan') return publish({ status: 'found', item: { ...describePlanItem(selected.item, true), lookup: { ...lookup, resolvedBy: 'plan-search' } } });
  return publish({
    status: 'missing_lookup',
    usage: `Unknown setup item ${lookup.input}. Use mode:"setup_posture" to inspect setup item ids.`,
  });
}
