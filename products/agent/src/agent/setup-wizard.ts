export type AgentSetupWizardSourceStatus = 'ready' | 'blocked' | 'recommended' | 'optional' | 'check';
export type AgentSetupWizardStatus = 'complete' | 'active' | 'blocked';
export type AgentSetupWizardStepStatus = 'done' | 'current' | 'pending' | 'blocked';
export type AgentSetupWizardCloseoutStatus = 'complete' | 'ready-to-finish' | 'needs-smoke-evidence' | 'blocked';

export interface AgentSetupWizardSourceItem {
  readonly id: string;
  readonly label: string;
  readonly status: AgentSetupWizardSourceStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId?: string;
}

export interface AgentSetupWizardBlockedCheckFrequency {
  readonly checkId: string;
  readonly count: number;
}

export interface AgentSetupWizardSmokeHistory {
  readonly status: 'available' | 'none' | 'unavailable';
  readonly total: number;
  readonly trend: string;
  readonly latestResult: string | null;
  readonly previousResult: string | null;
  readonly latestEvidenceId?: string | null;
  readonly latestEvidenceAt?: string | null;
  readonly resultCounts: Readonly<Record<string, number>>;
  readonly blockedCheckFrequency: readonly AgentSetupWizardBlockedCheckFrequency[];
  readonly inspectLatestRoute: string | null;
  readonly rerunRoute: string;
  readonly saveRoute: string;
  readonly reason?: string;
}

export interface AgentSetupWizardRepeatedBlocker {
  readonly setupItemId: string;
  readonly checkId: string;
  readonly count: number;
  readonly summary: string;
}

export interface AgentSetupWizardStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentSetupWizardStepStatus;
  readonly sourceStatus: AgentSetupWizardSourceStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId: string;
  readonly backtrackRoute: string | null;
}

export type AgentSetupWizardStepHistoryKind = 'setup-smoke';

export interface AgentSetupWizardStepHistoryEntry {
  readonly id: string;
  readonly stepId: string;
  readonly stepLabel: string;
  readonly kind: AgentSetupWizardStepHistoryKind;
  readonly receiptId: string;
  readonly recordedAt: string;
  readonly summary: string;
  readonly inspectRoute: string | null;
  readonly source?: string;
  readonly receiptStatus?: string;
  readonly satisfiesReceipt?: boolean;
}

export interface AgentSetupWizardReceiptGap {
  readonly stepId: string;
  readonly stepLabel: string;
  readonly requiredReceipt: string;
  readonly summary: string;
}

export interface AgentSetupWizardCloseout {
  readonly status: AgentSetupWizardCloseoutStatus;
  readonly label: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly primaryStepId: string | null;
  readonly primaryStepLabel: string | null;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly requiresConfirmation: boolean;
  readonly evidence: readonly string[];
  readonly policy: string;
}

export interface AgentSetupWizardDiagnostic {
  readonly repeatedBlocker: AgentSetupWizardRepeatedBlocker | null;
  readonly smokeHistory: AgentSetupWizardSmokeHistory;
  readonly stepHistory: readonly AgentSetupWizardStepHistoryEntry[];
  readonly receiptGaps: readonly AgentSetupWizardReceiptGap[];
  readonly closeout: AgentSetupWizardCloseout;
}

export interface AgentSetupWizard {
  readonly available: true;
  readonly status: AgentSetupWizardStatus;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly progressLabel: string;
  readonly next: string;
  readonly reviewRoute: string;
  readonly steps: readonly AgentSetupWizardStep[];
  readonly _diagnostic: AgentSetupWizardDiagnostic;
}

export interface BuildAgentSetupWizardInput {
  readonly items: readonly AgentSetupWizardSourceItem[];
  readonly smokeHistory?: AgentSetupWizardSmokeHistory;
  readonly closeoutCriticalStepIds?: readonly string[];
  readonly setupMarkerExists?: boolean;
  readonly finishRoute?: string;
  readonly finishUserRoute?: string;
  readonly receiptRequiredStepIds?: readonly string[];
  readonly repeatedBlockerAliases?: Readonly<Record<string, readonly string[]>>;
  readonly reviewRoute?: string;
}

export const DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE = 'setup action:"status" includeParameters:true';
export const DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE = 'setup action:"smoke" setupItemId:"install-smoke" confirm:true explicitUserRequest:"..."';
export const DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE = 'setup action:"smoke" setupItemId:"install-smoke" fields:{...} confirm:true explicitUserRequest:"..."';
export const DEFAULT_AGENT_SETUP_WIZARD_FINISH_ROUTE = 'setup action:"finish" confirm:true explicitUserRequest:"Finish Agent onboarding after setup smoke evidence is ready."';
export const DEFAULT_AGENT_SETUP_WIZARD_FINISH_USER_ROUTE = 'System, Setup (the menu, Ctrl+G then m)';

export function emptyAgentSetupSmokeHistory(reason = 'No saved setup smoke evidence artifact found.'): AgentSetupWizardSmokeHistory {
  return {
    status: 'none',
    total: 0,
    trend: 'none',
    latestResult: null,
    previousResult: null,
    resultCounts: {},
    blockedCheckFrequency: [],
    inspectLatestRoute: null,
    rerunRoute: DEFAULT_AGENT_SETUP_WIZARD_RERUN_SMOKE_ROUTE,
    saveRoute: DEFAULT_AGENT_SETUP_WIZARD_SAVE_SMOKE_ROUTE,
    reason,
  };
}

function firstAttentionItem(items: readonly AgentSetupWizardSourceItem[]): AgentSetupWizardSourceItem | null {
  return items.find((item) => item.status === 'blocked')
    ?? items.find((item) => item.status === 'check')
    ?? items.find((item) => item.status === 'recommended')
    ?? items.find((item) => item.status === 'optional')
    ?? null;
}

function firstBlockingItem(items: readonly AgentSetupWizardSourceItem[]): AgentSetupWizardSourceItem | null {
  return items.find((item) => item.status === 'blocked')
    ?? items.find((item) => item.status === 'check')
    ?? null;
}

function itemFromRepeatedBlockers(
  items: readonly AgentSetupWizardSourceItem[],
  smokeHistory: AgentSetupWizardSmokeHistory,
  aliases: Readonly<Record<string, readonly string[]>>,
): { readonly item: AgentSetupWizardSourceItem; readonly blocker: AgentSetupWizardRepeatedBlocker } | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const frequency of smokeHistory.blockedCheckFrequency) {
    const candidates = aliases[frequency.checkId] ?? [frequency.checkId];
    for (const candidate of candidates) {
      const item = byId.get(candidate);
      if (!item || item.status === 'ready') continue;
      return {
        item,
        blocker: {
          setupItemId: item.id,
          checkId: frequency.checkId,
          count: frequency.count,
          summary: `${item.label} repeated in ${frequency.count} saved setup smoke run(s) as ${frequency.checkId}.`,
        },
      };
    }
  }
  return null;
}

function stepStatus(item: AgentSetupWizardSourceItem, currentId: string | null): AgentSetupWizardStepStatus {
  if (item.status === 'ready') return 'done';
  if (item.id === currentId) return 'current';
  if (item.status === 'blocked' || item.status === 'check') return 'blocked';
  return 'pending';
}

function buildStep(item: AgentSetupWizardSourceItem, currentId: string | null): AgentSetupWizardStep {
  const status = stepStatus(item, currentId);
  return {
    id: item.id,
    label: item.label,
    status,
    sourceStatus: item.status,
    detail: item.detail,
    userRoute: item.userRoute,
    modelRoute: item.modelRoute,
    actionId: item.actionId ?? item.id,
    backtrackRoute: status === 'done' || status === 'current' ? item.modelRoute : null,
  };
}

function validIso(value: string | null | undefined): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function setupReceiptKind(stepId: string): string {
  if (stepId === 'install-smoke') return 'setup smoke evidence receipt';
  return 'setup evidence receipt';
}

function setupStepAliases(stepId: string): readonly string[] {
  if (stepId === 'runtime' || stepId === 'connected-host-readiness') return ['runtime', 'connected-host-readiness'];
  return [stepId];
}

function setupStepMatches(left: string, right: string): boolean {
  const leftAliases = new Set(setupStepAliases(left));
  return setupStepAliases(right).some((alias) => leftAliases.has(alias));
}

function buildStepHistory(input: {
  readonly items: readonly AgentSetupWizardSourceItem[];
  readonly smokeHistory: AgentSetupWizardSmokeHistory;
}): readonly AgentSetupWizardStepHistoryEntry[] {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const history: AgentSetupWizardStepHistoryEntry[] = [];

  const smokeAt = validIso(input.smokeHistory.latestEvidenceAt);
  if (input.smokeHistory.latestEvidenceId && smokeAt) {
    const item = byId.get('install-smoke');
    const result = input.smokeHistory.latestResult ?? 'unknown';
    const ready = result === 'ready-for-user-run' || result === 'passed';
    history.push({
      id: `setup-step-history:install-smoke:setup-smoke:${input.smokeHistory.latestEvidenceId}`,
      stepId: 'install-smoke',
      stepLabel: item?.label ?? 'Install smoke',
      kind: 'setup-smoke',
      receiptId: input.smokeHistory.latestEvidenceId,
      recordedAt: smokeAt,
      summary: `Latest setup smoke evidence is ${result}.`,
      inspectRoute: input.smokeHistory.inspectLatestRoute,
      source: 'agent-setup-smoke-evidence',
      receiptStatus: result,
      satisfiesReceipt: ready,
    });
  }

  return history.sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || left.id.localeCompare(right.id));
}

function buildReceiptGaps(input: {
  readonly items: readonly AgentSetupWizardSourceItem[];
  readonly stepHistory: readonly AgentSetupWizardStepHistoryEntry[];
  readonly receiptRequiredStepIds: readonly string[];
}): readonly AgentSetupWizardReceiptGap[] {
  return input.receiptRequiredStepIds
    .filter((stepId) => !input.stepHistory.some((entry) => entry.satisfiesReceipt === true && setupStepMatches(stepId, entry.stepId)))
    .map((stepId) => {
      const item = input.items.find((candidate) => candidate.id === stepId);
      const stepLabel = item?.label ?? stepId;
      const requiredReceipt = setupReceiptKind(stepId);
      return {
        stepId,
        stepLabel,
        requiredReceipt,
        summary: `${stepLabel} has no ready ${requiredReceipt} yet; closeout counts only saved evidence with an id and timestamp.`,
      };
    });
}

/**
 * What the newest install-smoke evidence says: true when it is ready, false when
 * it is blocked or failed, null when there is none. Only the evidence the setup
 * smoke itself saved counts; a receipt cannot stand in for a smoke run.
 */
function newestSmokeVerdict(stepHistory: readonly AgentSetupWizardStepHistoryEntry[]): boolean | null {
  const latest = stepHistory.find((entry) => entry.kind === 'setup-smoke' && setupStepMatches('install-smoke', entry.stepId));
  return latest ? latest.satisfiesReceipt === true : null;
}

function buildCloseout(input: {
  readonly items: readonly AgentSetupWizardSourceItem[];
  readonly smokeHistory: AgentSetupWizardSmokeHistory;
  readonly setupSmokeReceiptReady: boolean;
  readonly smokeVerdict: boolean | null;
  readonly stepHistory: readonly AgentSetupWizardStepHistoryEntry[];
  readonly criticalStepIds: readonly string[];
  readonly setupMarkerExists: boolean;
  readonly reviewRoute: string;
  readonly finishRoute: string;
  readonly finishUserRoute: string;
}): AgentSetupWizardCloseout {
  const critical = new Set(input.criticalStepIds);
  // A critical step that is optional here (the connected host on an Agent used
  // on its own) does not block closeout.
  const primaryBlocker = input.items.find((item) => (
    critical.has(item.id) && item.status === 'blocked'
  )) ?? input.items.find((item) => critical.has(item.id) && item.status !== 'ready' && item.status !== 'optional') ?? null;
  const smokeReady = input.smokeVerdict
    ?? (input.smokeHistory.status === 'available' && (input.smokeHistory.latestResult === 'ready-for-user-run' || input.smokeHistory.latestResult === 'passed'));
  const latestSmoke = input.smokeHistory.status === 'available'
    ? input.smokeHistory.latestResult ?? 'unknown'
    : input.smokeHistory.status;
  const evidence = [
    `critical setup blockers: ${primaryBlocker ? `${primaryBlocker.label} (${primaryBlocker.status})` : 'none'}`,
    `setup marker: ${input.setupMarkerExists ? 'present' : 'missing'}`,
    `latest setup smoke: ${latestSmoke}`,
    `setup smoke receipt: ${input.setupSmokeReceiptReady ? 'ready' : 'missing'}`,
    `setup smoke history: ${input.smokeHistory.status}; total ${input.smokeHistory.total}; trend ${input.smokeHistory.trend}`,
  ];
  const policy = 'Setup closeout is advisory until a confirmed finish route writes the local onboarding marker. Optional setup recommendations do not block closeout, but unresolved critical blockers or missing ready setup smoke evidence do.';

  if (primaryBlocker) {
    return {
      status: 'blocked',
      label: 'Fix setup blocker',
      summary: `${primaryBlocker.label} is blocking normal Agent use.`,
      nextAction: primaryBlocker.detail,
      primaryStepId: primaryBlocker.id,
      primaryStepLabel: primaryBlocker.label,
      userRoute: primaryBlocker.userRoute,
      modelRoute: primaryBlocker.modelRoute,
      requiresConfirmation: false,
      evidence,
      policy,
    };
  }

  if (!smokeReady) {
    const prior = input.smokeHistory.latestResult === 'blocked'
      ? 'The latest saved setup smoke was blocked; rerun it now that critical setup is ready.'
      : input.smokeHistory.status === 'unavailable'
        ? 'Critical setup is ready, but this runtime cannot prove a saved setup smoke artifact.'
        : 'Critical setup is ready, but no ready setup smoke evidence is saved yet.';
    return {
      status: 'needs-smoke-evidence',
      label: 'Run final setup smoke',
      summary: prior,
      nextAction: 'Run the confirmed setup smoke route, capture user-visible package/status and first-turn output, then save the redacted evidence.',
      primaryStepId: 'install-smoke',
      primaryStepLabel: 'Install smoke',
      userRoute: 'System, Setup (the menu, Ctrl+G then m)',
      modelRoute: input.smokeHistory.saveRoute,
      requiresConfirmation: true,
      evidence,
      policy,
    };
  }

  if (!input.setupMarkerExists) {
    return {
      status: 'ready-to-finish',
      label: 'Finish setup',
      summary: 'Critical setup is ready and the latest saved setup smoke evidence is ready for user-run closeout.',
      nextAction: 'Write the onboarding completion marker so future launches start in the main conversation instead of first-run setup.',
      primaryStepId: 'finish-onboarding',
      primaryStepLabel: 'Finish onboarding state',
      userRoute: input.finishUserRoute,
      modelRoute: input.finishRoute,
      requiresConfirmation: true,
      evidence,
      policy,
    };
  }

  return {
    status: 'complete',
    label: 'Setup complete',
    summary: 'Critical setup, setup smoke evidence, and the onboarding completion marker are all present.',
    nextAction: 'Use setup only when provider, host, channel, automation, local behavior, or runtime-profile decisions change.',
    primaryStepId: null,
    primaryStepLabel: null,
    userRoute: 'the menu (Ctrl+G then m)',
    modelRoute: input.reviewRoute,
    requiresConfirmation: false,
    evidence,
    policy,
  };
}

export function buildAgentSetupWizard(input: BuildAgentSetupWizardInput): AgentSetupWizard {
  const smokeHistory = input.smokeHistory ?? emptyAgentSetupSmokeHistory();
  // A step's status is its live check; the setup smoke evidence is history beside it.
  const items = input.items;
  const repeated = itemFromRepeatedBlockers(items, smokeHistory, input.repeatedBlockerAliases ?? {});
  const blocking = firstBlockingItem(items);
  const current = repeated?.item ?? blocking ?? firstAttentionItem(items);
  const currentId = current?.id ?? null;
  const steps = items.map((item) => buildStep(item, currentId));
  const stepHistory = buildStepHistory({ items, smokeHistory });
  const smokeVerdict = newestSmokeVerdict(stepHistory);
  const setupSmokeReceiptReady = smokeVerdict === true;
  const receiptGaps = buildReceiptGaps({
    items,
    stepHistory,
    receiptRequiredStepIds: input.receiptRequiredStepIds ?? [],
  });
  const completedSteps = steps.filter((step) => step.status === 'done').length;
  const status: AgentSetupWizardStatus = completedSteps === steps.length
    ? 'complete'
    : current?.status === 'blocked' || current?.status === 'check'
      ? 'blocked'
      : 'active';
  const next = current
    ? repeated
      ? `${current.label}: ${repeated.blocker.summary} ${current.detail}`
      : `${current.label}: ${current.detail}`
    : 'Setup wizard is complete; rerun setup smoke if this machine was upgraded or moved.';
  const closeout = buildCloseout({
    items,
    smokeHistory,
    setupSmokeReceiptReady,
    smokeVerdict,
    stepHistory,
    criticalStepIds: input.closeoutCriticalStepIds ?? [],
    setupMarkerExists: input.setupMarkerExists === true,
    reviewRoute: input.reviewRoute ?? DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
    finishRoute: input.finishRoute ?? DEFAULT_AGENT_SETUP_WIZARD_FINISH_ROUTE,
    finishUserRoute: input.finishUserRoute ?? DEFAULT_AGENT_SETUP_WIZARD_FINISH_USER_ROUTE,
  });
  return {
    available: true,
    status,
    completedSteps,
    totalSteps: steps.length,
    currentStepId: currentId,
    currentStepLabel: current?.label ?? null,
    progressLabel: `${completedSteps}/${steps.length} setup step(s) ready`,
    next,
    reviewRoute: input.reviewRoute ?? DEFAULT_AGENT_SETUP_WIZARD_REVIEW_ROUTE,
    steps,
    _diagnostic: {
      repeatedBlocker: repeated?.blocker ?? null,
      smokeHistory,
      stepHistory,
      receiptGaps,
      closeout,
    },
  };
}
