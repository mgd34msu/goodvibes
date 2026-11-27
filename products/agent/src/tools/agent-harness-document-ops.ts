import type { CommandContext } from '../input/command-registry.ts';
import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { buildAgentDocumentOpsPart } from '../input/runtime-snapshot.ts';
import { AGENT_ARTIFACT_LIST_LIMIT } from '../input/runtime-snapshot-builders.ts';
import type { AgentReviewPacketWizard, AgentReviewPacketWizardStep } from '../input/runtime-snapshot-types.ts';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { buildReviewerReadinessChecklist, readDocumentOpsSources } from './agent-harness-document-ops-reviewer-readiness.ts';
import type {
  AgentHarnessDocumentOpsArgs,
  DocumentOpsLane,
  DocumentOpsLaneId,
  DocumentOpsLaneResolution,
  DocumentOpsStatus,
  ReviewerReadinessCheck,
  ReviewerReadinessChecklist,
} from './agent-harness-document-ops-types.ts';
import { readString } from '@goodvibes/engine/terminal-shell/agent-turn/tool-args';
export type {
  DocumentOpsLaneId,
  DocumentOpsLaneResolution,
} from './agent-harness-document-ops-types.ts';

const LANE_IDS: readonly DocumentOpsLaneId[] = [
  'documents',
  'uploads',
  'exports',
  'reviewer_readiness',
  'review_packet_timeline',
  'review_packet_wizard',
  'source_library',
  'media_artifacts',
  'artifact_browser',
  'model_compare',
];

// Comparing, judging and switching to a winner are capabilities of Models and providers (capability_run compare.*),
// controls on its Comparisons tab.
const MODEL_COMPARE_CONTROLS = [
  'Models and providers, Comparisons',
] as const;

function hasTool(context: CommandContext, toolName: string): boolean {
  return context.extensions.toolRegistry.has(toolName);
}

function searchText(lane: DocumentOpsLane): string {
  return [
    lane.id,
    lane.label,
    lane.status,
    lane.outcome,
    lane.current,
    lane.next,
    lane.userRoute,
    lane.modelRoute,
    lane.signals.join('\n'),
    lane.controls.join('\n'),
    lane.reviewPacketWizard ? [
      lane.reviewPacketWizard.status,
      lane.reviewPacketWizard.next,
      lane.reviewPacketWizard.finalReview,
      lane.reviewPacketWizard.steps.map((step) => [
        step.id,
        step.label,
        step.status,
        step.detail,
        step.userRoute,
        step.modelRoute,
        step.backtrackRoute ?? '',
      ].join(' ')).join('\n'),
    ].join('\n') : '',
    lane.reviewerReadiness ? [
      lane.reviewerReadiness.status,
      lane.reviewerReadiness.next,
      lane.reviewerReadiness.policy,
      lane.reviewerReadiness.checks.map((check) => [
        check.id,
        check.label,
        check.status,
        check.detail,
        check.inspectRoute,
        check.repairRoute ?? '',
      ].join(' ')).join('\n'),
    ].join('\n') : '',
  ].join('\n');
}

function describeReviewerReadinessCheck(check: ReviewerReadinessCheck, includeParameters: boolean): Record<string, unknown> {
  return {
    id: check.id,
    label: check.label,
    status: check.status,
    count: check.count,
    detail: previewHarnessText(check.detail, includeParameters ? 180 : 96),
    inspectRoute: previewHarnessText(check.inspectRoute, includeParameters ? 180 : 96),
    ...(check.repairRoute ? { repairRoute: previewHarnessText(check.repairRoute, includeParameters ? 240 : 120) } : {}),
  };
}

function describeReviewerReadiness(checklist: ReviewerReadinessChecklist, includeParameters: boolean): Record<string, unknown> {
  return {
    status: checklist.status,
    next: previewHarnessText(checklist.next, includeParameters ? 220 : 120),
    summary: checklist.summary,
    checks: checklist.checks
      .slice(0, includeParameters ? checklist.checks.length : 4)
      .map((check) => describeReviewerReadinessCheck(check, includeParameters)),
    policy: previewHarnessText(checklist.policy, includeParameters ? 220 : 120),
  };
}

export function describeReviewPacketWizardStep(step: AgentReviewPacketWizardStep, includeParameters: boolean): Record<string, unknown> {
  return {
    id: step.id,
    label: step.label,
    status: step.status,
    detail: previewHarnessText(step.detail, includeParameters ? 180 : 96),
    userRoute: previewHarnessText(step.userRoute, includeParameters ? 180 : 96),
    modelRoute: step.modelRoute,
    ...(step.control === null ? {} : { control: step.control }),
    ...(step.backtrackRoute ? { backtrackRoute: step.backtrackRoute } : {}),
  };
}

function describeReviewPacketPresetLineage(
  lineage: AgentReviewPacketWizard['presetLineage'],
  includeParameters: boolean,
): Record<string, unknown> | null {
  if (!lineage) return null;
  return {
    artifactId: lineage.artifactId,
    presetId: lineage.presetId,
    name: lineage.name,
    refreshed: lineage.refreshed,
    refreshedFromArtifactId: lineage.refreshedFromArtifactId,
    refreshedFromPresetId: lineage.refreshedFromPresetId,
    freshnessMissingCount: lineage.freshnessMissingCount,
    freshnessSupersededCount: lineage.freshnessSupersededCount,
    freshnessUnresolvedCount: lineage.freshnessUnresolvedCount,
    summary: previewHarnessText(lineage.summary, includeParameters ? 220 : 120),
    inspectRoute: previewHarnessText(lineage.inspectRoute, includeParameters ? 220 : 120),
  };
}

function describeReviewPacketWizard(wizard: AgentReviewPacketWizard, includeParameters: boolean): Record<string, unknown> {
  const presetLineage = describeReviewPacketPresetLineage(wizard.presetLineage, includeParameters);
  return {
    status: wizard.status,
    progress: `${wizard.completedSteps}/${wizard.totalSteps}`,
    completedSteps: wizard.completedSteps,
    totalSteps: wizard.totalSteps,
    currentStepId: wizard.currentStepId,
    currentStepLabel: wizard.currentStepLabel,
    next: previewHarnessText(wizard.next, includeParameters ? 240 : 120),
    finalReview: previewHarnessText(wizard.finalReview, includeParameters ? 220 : 120),
    ...(presetLineage ? { presetLineage } : {}),
    steps: wizard.steps
      .slice(0, includeParameters ? wizard.steps.length : 4)
      .map((step) => describeReviewPacketWizardStep(step, includeParameters)),
    policy: 'The review packet wizard is read-only. It guides the user through existing document, comparison, handoff, route-decision, archive, and share routes; every write or external delivery still requires the owning recorded effect admission.',
  };
}

export function describeLane(lane: DocumentOpsLane, includeParameters: boolean): Record<string, unknown> {
  return {
    id: lane.id,
    label: lane.label,
    status: lane.status,
    outcome: lane.outcome,
    current: lane.current,
    next: lane.next,
    userRoute: previewHarnessText(lane.userRoute, 96),
    modelRoute: lane.modelRoute,
    signals: lane.signals,
    ...(lane.reviewerReadiness ? { reviewerReadiness: describeReviewerReadiness(lane.reviewerReadiness, includeParameters) } : {}),
    ...(lane.reviewPacketWizard ? { reviewPacketWizard: describeReviewPacketWizard(lane.reviewPacketWizard, includeParameters) } : {}),
    ...(includeParameters ? {
      routes: {
        user: lane.userRoute,
        model: lane.modelRoute,
      },
      controls: lane.controls,
      safety: 'Document writes, file ingest, export, media generation, model comparison, and model changes stay explicit user-visible actions. Blind model comparison spends tokens only through admitted agent_model_compare runs.',
    } : {}),
  };
}

/*
 * The controls each lane's work is done with, as a person reaches them: place, tab, key (what the key says). The
 * review packet's steps name theirs the same way (terminal-shell review-packet-report.ts). They are constants of the
 * build, not of this run, so no lane status depends on them.
 */
const DRAFTS = 'Memory and knowledge, Drafts';
const ARTIFACTS = 'Memory and knowledge, Artifacts';
const SOURCES = 'Memory and knowledge, Sources';
const DOCUMENT_CONTROLS = [
  `${DRAFTS}, w (new draft)`, `${DRAFTS}, f (search)`, `${DRAFTS}, s (read in full)`, `${DRAFTS}, Enter (revise)`,
  `${DRAFTS}, v (mark reviewed)`, `${DRAFTS}, c (comment)`, `${DRAFTS}, o (resolve a comment)`, `${DRAFTS}, g (suggest a change)`,
  `${DRAFTS}, y (take a suggestion)`, `${DRAFTS}, l (leave a suggestion)`, `${DRAFTS}, i (put an artifact in)`,
  `${DRAFTS}, k (attach an artifact)`, `${DRAFTS}, e (save as an artifact)`, `${DRAFTS}, p (save a review packet preset)`,
  `${ARTIFACTS}, u (refresh as a preset)`, `${DRAFTS}, d (ready for review?)`, `${DRAFTS}, t (review packet steps)`,
  `${DRAFTS}, h (review packet timeline)`,
] as const;
const UPLOAD_CONTROLS = ['This conversation, Controls, Send an image with a message', `${DRAFTS}, k (attach an artifact)`,
  `${SOURCES}, f (add a file)`, `${SOURCES}, u (add a list of pages)`, `${SOURCES}, b (add bookmarks)`, `${SOURCES}, h (add browser history)`,
  `${SOURCES}, j (add a saved artifact)`] as const;
const EXPORT_CONTROLS = ['Sessions, Sessions, w (write to a file)', `${DRAFTS}, e (save as an artifact)`, `${ARTIFACTS}, e (copy to a file)`,
  `${ARTIFACTS}, k (copy into a package)`] as const;
const SOURCE_CONTROLS = [`${SOURCES}, s (search)`, `${SOURCES}, Enter on the source`, 'Memory and knowledge, q (ask your knowledge)'] as const;
const MEDIA_CONTROLS = ['Tools and extensions, Tools, M (make an image or a video)', 'Work and agents, J (collect a media job)'] as const;
const ARTIFACT_BROWSER_CONTROLS = [`${ARTIFACTS}, f (search)`, `${ARTIFACTS}, Enter (look at it)`, `${ARTIFACTS}, e (copy to a file)`,
  `${ARTIFACTS}, k (copy into a package)`, `${SOURCES}, j (add a saved artifact)`, `${DRAFTS}, i (put an artifact in)`,
  `${DRAFTS}, k (attach an artifact)`] as const;
const REVIEW_CONTROLS = [`${DRAFTS}, s (read in full)`, `${DRAFTS}, d (ready for review?)`, `${DRAFTS}, o (resolve a comment)`,
  `${DRAFTS}, y (take a suggestion)`, `${DRAFTS}, l (leave a suggestion)`, `${DRAFTS}, k (attach an artifact)`, `${DRAFTS}, e (save as an artifact)`,
  `${ARTIFACTS}, f (search)`, `${ARTIFACTS}, Enter (look at it)`] as const;

/**
 * The lanes, built once per call from run-time facts only: which tools are
 * registered, whether the artifact store and document registry can be read,
 * whether Agent Knowledge and a generation provider are present, and what
 * review work is waiting. The documents and the artifact list are each read
 * once and shared by the timeline, the wizard and the readiness checklist.
 */
function buildLanes(context: CommandContext): readonly DocumentOpsLane[] {
  const sources = readDocumentOpsSources(context);
  const snapshot = buildAgentDocumentOpsPart(context, {
    documentDrafts: sources.documents.items,
    artifactList: {
      available: sources.artifactsListable && sources.artifacts.problem === undefined,
      items: sources.artifacts.items.slice(0, AGENT_ARTIFACT_LIST_LIMIT),
      truncated: sources.artifacts.items.length >= AGENT_ARTIFACT_LIST_LIMIT,
    },
  });
  const store = context.platform.artifactStore;
  const storeWritable = typeof store?.create === 'function';
  const storeReadable = sources.artifactsListable && typeof store?.readContent === 'function' && sources.artifacts.problem === undefined;
  const documentsReadable = sources.documents.problem === undefined;
  const knowledgeReachable = Boolean(context.clients?.agentKnowledgeApi);
  const documentsReady = hasTool(context, 'agent_documents') && documentsReadable;
  const artifactBrowserReady = hasTool(context, 'agent_artifacts') && hasTool(context, 'agent_knowledge_ingest') && storeReadable;
  const modelCompareReady = hasTool(context, 'agent_model_compare') && storeWritable;
  const reviewerReadiness = buildReviewerReadinessChecklist(context, { documentsReady, modelCompareReady, artifactBrowserReady }, sources);
  const drafts = sources.documents.items.filter((document) => document.status !== 'archived');
  const maxMegabytes = Math.round(snapshot.artifactMaxBytes / (1024 * 1024));
  const storeProblem = sources.artifacts.problem;

  return [
    {
      id: 'documents',
      label: 'Documents',
      status: documentsReady ? 'ready' : hasTool(context, 'agent_documents') ? 'attention' : 'needs-setup',
      outcome: 'Draft, revise, and export user-facing documents without leaving the Agent conversation.',
      current: documentsReadable
        ? `${drafts.length} active draft(s) of ${sources.documents.items.length}.`
        : `Drafts could not be read: ${sources.documents.problem}.`,
      next: documentsReady
        ? 'Use agent_documents to browse, revise, comment, accept suggestions and export a draft.'
        : !hasTool(context, 'agent_documents')
          ? 'This session has no agent_documents tool; draft in the conversation and export the transcript instead.'
          : 'Open a workspace (the document registry lives in it), then read this lane again.',
      userRoute: 'Memory and knowledge, Drafts, w (new draft)',
      modelRoute: documentsReady ? 'agent_documents' : 'capability_run id:"documents.list"',
      signals: [
        `Chat route ${snapshot.provider} / ${snapshot.modelDisplayName}`,
        `Document draft tool: ${hasTool(context, 'agent_documents') ? 'available' : 'missing'}`,
        `Drafts ${drafts.length}`,
      ],
      controls: DOCUMENT_CONTROLS,
    },
    {
      id: 'uploads',
      label: 'Uploads',
      status: !store ? 'needs-setup' : !storeWritable || storeProblem ? 'attention' : 'ready',
      outcome: 'Attach, paste, or ingest files and URLs through explicit user-visible routes.',
      current: !store
        ? 'No artifact store is available in this runtime.'
        : storeProblem
          ? `The artifact store could not be read: ${storeProblem}.`
          : `${sources.artifacts.items.length} artifact(s) stored; up to ${maxMegabytes} MB each.${storeWritable ? '' : ' The store is read-only here.'}`,
      next: store && storeWritable
        ? 'Attach a file as prompt context, or ingest it as Agent Knowledge when it should last.'
        : 'Uploads need a writable artifact store; check the connected host (host action:"status").',
      userRoute: 'Memory and knowledge, Drafts, k (attach an artifact)',
      modelRoute: 'capability_find need:"add a file to Agent Knowledge"',
      signals: [
        `Artifact store ${!store ? 'missing' : storeWritable ? 'writable' : 'read-only'}`,
        `Artifact max ${maxMegabytes} MB`,
      ],
      controls: UPLOAD_CONTROLS,
    },
    {
      id: 'exports',
      label: 'Exports',
      status: !context.workspace?.shellPaths ? 'needs-setup' : storeProblem ? 'attention' : 'ready',
      outcome: 'Turn conversations, sessions, documents, and saved artifacts into local files the user can keep or reuse.',
      current: context.workspace?.shellPaths
        ? `Exports write into the workspace; ${drafts.length} draft(s) and ${sources.artifacts.items.length} artifact(s) can be exported.`
        : 'No workspace is open, so there is nowhere to write an export.',
      next: context.workspace?.shellPaths
        ? 'Export the conversation, the session, a draft, or saved artifacts as a file or package.'
        : 'Open a workspace, then export.',
      userRoute: 'Memory and knowledge, Drafts, e (save as an artifact)',
      modelRoute: 'capability_run id:"documents.export"',
      signals: [
        `Session ${snapshot.sessionId}`,
      ],
      controls: EXPORT_CONTROLS,
    },
    {
      id: 'reviewer_readiness',
      label: 'Reviewer Readiness',
      status: reviewerReadiness.status === 'ready' ? 'ready' : reviewerReadiness.status === 'attention' ? 'attention' : 'needs-setup',
      outcome: 'Know what must be resolved before exporting, handing off, archiving, or applying comparison-backed route changes.',
      current: `${reviewerReadiness.summary.documents} document draft(s), ${reviewerReadiness.summary.openComments} open comment(s), ${reviewerReadiness.summary.proposedSuggestions} proposed suggestion(s), ${reviewerReadiness.summary.savedComparisons} saved comparison(s), ${reviewerReadiness.summary.revealedJudgments} revealed judgment(s).`,
      next: reviewerReadiness.next,
      userRoute: 'Memory and knowledge, Drafts, d (ready for review?)',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"reviewer_readiness"',
      signals: [
        `Reviewer readiness ${reviewerReadiness.status}`,
        `Open comments ${reviewerReadiness.summary.openComments}`,
        `Proposed suggestions ${reviewerReadiness.summary.proposedSuggestions}`,
        `Missing source artifacts ${reviewerReadiness.summary.documentsMissingSourceArtifacts}`,
        `Unrevealed comparisons ${reviewerReadiness.summary.unrevealedComparisons}`,
        `Hidden judgments ${reviewerReadiness.summary.hiddenJudgments}`,
        `Judgments awaiting a route decision ${reviewerReadiness.summary.judgmentsAwaitingRouteDecision}`,
        `Handoffs missing related evidence ${reviewerReadiness.summary.handoffsMissingRelatedArtifacts}`,
      ],
      controls: REVIEW_CONTROLS,
      reviewerReadiness,
    },
    {
      id: 'review_packet_timeline',
      label: 'Review Packet Timeline',
      status: !snapshot.reviewPacketTimeline.available
        ? 'needs-setup'
        : snapshot.reviewPacketTimeline.items.some((event) => event.status === 'attention')
          ? 'attention'
          : snapshot.reviewPacketTimeline.count > 0
          ? 'ready'
          : 'partial',
      outcome: 'Scan one chronological packet history across document review, source evidence, blind comparisons, judgments, handoffs, archives, and route decisions.',
      current: snapshot.reviewPacketTimeline.items[0]
        ? `${snapshot.reviewPacketTimeline.count} packet event(s); latest ${snapshot.reviewPacketTimeline.items[0].label}.`
        : 'No document, artifact, comparison, judgment, handoff, archive, or route-decision packet events are available yet.',
      next: snapshot.reviewPacketTimeline.next,
      userRoute: 'Memory and knowledge, Drafts, h (review packet timeline)',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"review_packet_timeline"',
      signals: [
        `Timeline available ${snapshot.reviewPacketTimeline.available ? 'yes' : 'no'}`,
        `Timeline events ${snapshot.reviewPacketTimeline.count}`,
        ...snapshot.reviewPacketTimeline.items.slice(0, 5).map((event) => `${event.status}: ${event.kind} ${event.label} -> ${event.route}`),
      ],
      controls: [`${DRAFTS}, h (review packet timeline)`, ...REVIEW_CONTROLS],
      reviewPacketTimeline: snapshot.reviewPacketTimeline,
    },
    {
      id: 'review_packet_wizard',
      label: 'Review Packet Wizard',
      status: snapshot.reviewPacketWizard.status === 'complete'
        ? 'ready'
        : snapshot.reviewPacketWizard.status === 'blocked'
          ? 'needs-setup'
          : snapshot.reviewPacketWizard.status === 'empty'
            ? 'partial'
            : 'attention',
      outcome: 'Carry one reviewer packet through draft review, document export, comparison judgment, reviewer handoff, route decision, and final archive review without re-entering ids.',
      current: snapshot.reviewPacketWizard.currentStepLabel
        ? `${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps} step(s) complete; current ${snapshot.reviewPacketWizard.currentStepLabel}.`
        : `${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps} step(s) complete.`,
      next: snapshot.reviewPacketWizard.next,
      userRoute: 'Memory and knowledge, Drafts, t (review packet steps)',
      modelRoute: 'agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"',
      signals: [
        `Wizard status ${snapshot.reviewPacketWizard.status}`,
        `Wizard progress ${snapshot.reviewPacketWizard.completedSteps}/${snapshot.reviewPacketWizard.totalSteps}`,
        `Current step ${snapshot.reviewPacketWizard.currentStepLabel ?? 'none'}`,
        `Final review ${snapshot.reviewPacketWizard.finalReview}`,
        ...snapshot.reviewPacketWizard.steps.map((step) => `${step.status}: ${step.label} -> ${step.modelRoute}`),
      ],
      controls: [...new Set([`${DRAFTS}, t (review packet steps)`, `${ARTIFACTS}, d (send as a review packet)`,
        ...snapshot.reviewPacketWizard.steps.flatMap((step) => (step.control === null ? [] : [step.control]))])],
      reviewPacketWizard: snapshot.reviewPacketWizard,
    },
    {
      id: 'source_library',
      label: 'Sources',
      status: knowledgeReachable ? 'ready' : 'needs-setup',
      outcome: 'Inspect source-backed records before citing, summarizing, or promoting knowledge.',
      current: knowledgeReachable
        ? 'Agent Knowledge is connected; sources can be searched, shown and ingested.'
        : 'Agent Knowledge is not connected in this session, so sources cannot be searched.',
      next: knowledgeReachable
        ? 'Search or show a source before citing it; ingest reviewed files or URLs only through explicit source actions.'
        : 'Check the connected host (host action:"status"); Agent Knowledge is served by it.',
      userRoute: 'Memory and knowledge, Sources, Enter on the source',
      modelRoute: 'capability_find need:"see the Agent Knowledge sources"',
      signals: [
        `Knowledge route ${snapshot.knowledgeRoute}`,
        `Knowledge isolation ${snapshot.knowledgeIsolation}`,
      ],
      controls: SOURCE_CONTROLS,
    },
    {
      id: 'media_artifacts',
      label: 'Media Artifacts',
      status: snapshot.mediaGenerationProviderCount > 0 ? (storeWritable ? 'ready' : 'attention') : 'needs-setup',
      outcome: 'Generate image or video artifacts through configured providers and keep generated bytes out of the transcript.',
      current: `${snapshot.voiceMediaReadiness.readyMediaProviderCount}/${snapshot.mediaProviderCount} media provider(s) ready; ${snapshot.mediaGenerationProviderCount} generation provider(s).`,
      next: snapshot.mediaGenerationProviderCount > 0
        ? storeWritable ? 'Use admitted media generation when the user asks for a concrete artifact.' : 'A generation provider is set but the artifact store is not writable, so a result could not be saved.'
        : 'Configure a media generation provider before claiming generated media is ready.',
      userRoute: 'Tools and extensions, Tools, M (make an image or a video)',
      modelRoute: 'agent_media_generate',
      signals: [
        `${snapshot.mediaGenerationProviderCount} generation provider(s)`,
      ],
      controls: MEDIA_CONTROLS,
    },
    {
      id: 'artifact_browser',
      label: 'Artifact Browser',
      status: artifactBrowserReady ? 'ready' : store ? 'attention' : 'needs-setup',
      outcome: 'Find and reuse uploaded, exported, generated, and source-backed artifacts from one place.',
      current: storeReadable
        ? `${sources.artifacts.items.length} artifact(s) in the store${sources.artifacts.problem ? ` (${sources.artifacts.problem})` : ''}.`
        : store ? `The artifact store could not be listed or read: ${storeProblem ?? 'it has no list or read method here'}.` : 'No artifact store is available in this runtime.',
      next: artifactBrowserReady
        ? 'Browse, show, export, package or promote artifacts with agent_artifacts and agent_knowledge_ingest.'
        : !hasTool(context, 'agent_artifacts') || !hasTool(context, 'agent_knowledge_ingest')
          ? 'This session lacks agent_artifacts or agent_knowledge_ingest; list artifacts in Memory and knowledge, Artifacts instead.'
          : 'Check the connected host (host action:"status"); the artifact store is served by it.',
      userRoute: 'Memory and knowledge, Artifacts (k copies into a package), and Sources (j adds a saved artifact)',
      modelRoute: artifactBrowserReady ? 'agent_artifacts + agent_knowledge_ingest' : 'capability_run id:"documents.list"',
      signals: [
        `Artifact browser tool: ${hasTool(context, 'agent_artifacts') ? 'available' : 'missing'}`,
        `Knowledge ingest tool: ${hasTool(context, 'agent_knowledge_ingest') ? 'available' : 'missing'}`,
        `Artifact store: ${storeReadable ? 'readable' : store ? 'not readable' : 'missing'}`,
      ],
      controls: ARTIFACT_BROWSER_CONTROLS,
    },
    {
      id: 'model_compare',
      label: 'Blind Model Compare',
      status: modelCompareReady ? 'ready' : hasTool(context, 'agent_model_compare') ? 'attention' : 'needs-setup',
      outcome: 'Run the same prompt across multiple models, hide model identities while judging, save a judgment, then apply the revealed winner or record leave-unchanged evidence only after recorded effect admission.',
      current: `${reviewerReadiness.summary.savedComparisons} saved comparison(s), ${reviewerReadiness.summary.hiddenJudgments} judgment(s) not yet revealed, ${reviewerReadiness.summary.judgmentsAwaitingRouteDecision} awaiting a route decision.`,
      next: modelCompareReady
        ? 'Run a comparison with agent_model_compare; reveal and judge it before applying a route change.'
        : hasTool(context, 'agent_model_compare')
          ? 'The artifact store is not writable here, so a comparison could not be saved; check the connected host.'
          : 'This session has no agent_model_compare tool; inspect models with models action:"status".',
      userRoute: 'Models and providers, Comparisons',
      modelRoute: modelCompareReady ? 'agent_model_compare' : 'models action:"status"',
      signals: [
        `Current model ${snapshot.provider} / ${snapshot.modelDisplayName}`,
        `Blind compare runner: ${hasTool(context, 'agent_model_compare') ? 'available' : 'missing'}`,
        `Saved comparison artifacts: ${storeWritable ? 'writable' : 'not writable'}`,
      ],
      controls: MODEL_COMPARE_CONTROLS,
    },
  ];
}

function nextActions(lanes: readonly DocumentOpsLane[]): readonly string[] {
  const urgent = lanes
    .filter((lane) => lane.status === 'gap' || lane.status === 'needs-setup' || lane.status === 'attention')
    .map((lane) => `${lane.label}: ${lane.next}`);
  const partial = lanes
    .filter((lane) => lane.status === 'partial')
    .map((lane) => `${lane.label}: ${lane.next}`);
  return [...urgent, ...partial].slice(0, 5);
}

/** One lane as built (the daemon reports the same packet in plain words: documents.readiness, packet-steps, timeline). */
export function readDocumentOpsLane(context: CommandContext, laneId: DocumentOpsLaneId): DocumentOpsLane | undefined {
  return buildLanes(context).find((lane) => lane.id === laneId);
}

export function documentOpsCatalogStatus(context: CommandContext): Record<string, unknown> {
  const lanes = buildLanes(context);
  const counts = lanes.reduce<Record<DocumentOpsStatus, number>>((acc, lane) => {
    acc[lane.status] += 1;
    return acc;
  }, { ready: 0, attention: 0, partial: 0, 'needs-setup': 0, gap: 0 });
  return {
    modes: ['document_ops', 'document_ops_lane'],
    lanes: lanes.length,
    ...counts,
  };
}

export function documentOpsSummary(context: CommandContext, args: AgentHarnessDocumentOpsArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const lanes = buildLanes(context);
  const reviewerReadiness = lanes.find((lane) => lane.id === 'reviewer_readiness')?.reviewerReadiness;
  return {
    lanes: lanes.map((lane) => describeLane(lane, includeParameters)),
    returned: lanes.length,
    total: lanes.length,
    ...(reviewerReadiness ? { reviewerReadiness: describeReviewerReadiness(reviewerReadiness, includeParameters) } : {}),
    policy: 'Document Ops unifies versioned document drafts, chronological review packet timelines, guided review packet wizard progress, reviewer-readiness checks, review comments, AI suggestion review, uploads, exports, sources, media artifacts, artifact browsing, artifact-to-Knowledge promotion, and model comparison.',
    nextActions: nextActions(lanes),
  };
}

export async function describeDocumentOpsLane(context: CommandContext, args: AgentHarnessDocumentOpsArgs, options: CatalogRankingOptions = {}): Promise<DocumentOpsLaneResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const laneId = readString(args.laneId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = laneId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: `document_ops_lane requires laneId, target, or query. Lane ids: ${LANE_IDS.join(', ')}.`,
    };
  }
  const normalized = input.toLowerCase();
  // An unknown lane id is answered from the id list without reading any store.
  if (laneId && !LANE_IDS.includes(normalized as DocumentOpsLaneId)) {
    return { status: 'missing_lookup', usage: `Unknown Document Ops lane ${input}. Lane ids: ${LANE_IDS.join(', ')}.` };
  }
  // One build per call: the description is consistent with the reads it was built from.
  const lanes = buildLanes(context);
  const exact = lanes.find((lane) => lane.id === normalized);
  if (exact) return { status: 'found', lane: describeLane(exact, true) };
  const selected = laneId ? { matches: [], judgments: [] } : await rankHarnessCatalog(lanes, input,
    lane => ({ id: lane.id, description: searchText(lane) }), 'agent.harness.document-ops', options);
  options.signal?.throwIfAborted();
  const matches = selected.matches;
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') return { status: 'found', lane: { ...describeLane(matches[0]!.entry, true), judgment: matches[0]!.judgment } };
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.map(({ entry: lane, judgment }) => ({
        laneId: lane.id, label: lane.label, status: lane.status, modelRoute: lane.modelRoute, judgment,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown Document Ops lane ${input}. Lane ids: ${LANE_IDS.join(', ')}.`,
  };
}
