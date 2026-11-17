import type { AgentWorkspaceLocalEditor, AgentWorkspaceReviewPacketDefaults } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentDocumentReviewerReadinessToolArgs {
  readonly mode: 'document_ops_lane';
  readonly laneId: 'reviewer_readiness' | 'review_packet_wizard';
  readonly includeParameters: boolean;
}

export interface AgentDocumentReviewPacketPresetToolArgs {
  readonly mode: 'save';
  readonly name: string;
  readonly documentId?: string;
  readonly documentTitle?: string;
  readonly documentExportArtifactId?: string;
  readonly comparisonArtifactId?: string;
  readonly judgmentArtifactId?: string;
  readonly revealedJudgmentArtifactId?: string;
  readonly routeDecisionArtifactId?: string;
  readonly routeDecision?: string;
  readonly handoffArtifactId?: string;
  readonly handoffArchiveArtifactId?: string;
  readonly relatedArtifactIds: readonly string[];
  readonly summary?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentDocumentReviewPacketPresetRefreshToolArgs {
  readonly mode: 'refresh';
  readonly artifactId: string;
  readonly name?: string;
  readonly summary?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentDocumentReviewPacketShareToolArgs {
  readonly archiveArtifactId: string;
  readonly title?: string;
  readonly message?: string;
  readonly channel?: string;
  readonly route?: string;
  readonly webhook?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export function createAgentDocumentReviewerReadinessEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-reviewer-readiness',
    mode: 'create',
    title: 'Review Readiness Preflight',
    selectedFieldIndex: 0,
    message: 'Inspect unresolved document comments, proposed suggestions, missing source artifacts, unrevealed comparisons, route-change decisions, and reviewer handoff evidence before export, archive, or route update.',
    fields: [
      { id: 'includeRoutes', label: 'Repair routes', value: 'yes', required: false, multiline: false, hint: 'yes/no. Yes includes exact inspect and repair routes for the next action.' },
    ],
  };
}

export function createAgentDocumentReviewPacketWizardEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-wizard',
    mode: 'create',
    title: 'Review Packet Wizard',
    selectedFieldIndex: 0,
    message: 'Walk the current reviewer packet through draft review, document export, comparison judgment, handoff, route decision, and final archive review. This is read-only and returns existing routes.',
    fields: [
      { id: 'focus', label: 'Focus', value: 'next', required: false, multiline: false, hint: 'next, all, blocked, backtrack, or final. The wizard never mutates state by itself.' },
      { id: 'includeRoutes', label: 'Routes', value: 'yes', required: false, multiline: false, hint: 'yes/no. Yes includes exact user, model, action, and backtrack routes.' },
    ],
  };
}

export function createAgentDocumentReviewPacketPresetEditor(
  defaults: AgentWorkspaceReviewPacketDefaults | null = null,
): AgentWorkspaceLocalEditor {
  const title = defaults?.documentTitle || defaults?.documentId || 'Current reviewer packet';
  return {
    kind: 'document-review-packet-preset',
    mode: 'create',
    title: 'Save Review Packet Preset',
    selectedFieldIndex: 0,
    message: 'Save the current document, comparison, judgment, route decision, handoff, archive, and related evidence ids as a reusable local preset artifact. This does not change the document, selected model, or archive state.',
    fields: [
      { id: 'name', label: 'Preset name', value: `${title} preset`, required: true, multiline: false, hint: 'Short user-visible name for reusing this review packet.' },
      { id: 'documentId', label: 'Document id', value: defaults?.documentId ?? '', required: false, multiline: false, hint: 'Agent document draft id.' },
      { id: 'documentTitle', label: 'Document title', value: defaults?.documentTitle ?? '', required: false, multiline: false, hint: 'Optional title shown in preset summaries.' },
      { id: 'documentExportArtifactId', label: 'Document export', value: defaults?.documentExportArtifactId ?? '', required: false, multiline: false, hint: 'Exported document evidence artifact id.' },
      { id: 'comparisonArtifactId', label: 'Comparison', value: defaults?.comparisonArtifactId ?? '', required: false, multiline: false, hint: 'Saved blind comparison artifact id.' },
      { id: 'judgmentArtifactId', label: 'Judgment', value: defaults?.judgmentArtifactId ?? '', required: false, multiline: false, hint: 'Saved comparison judgment artifact id.' },
      { id: 'revealedJudgmentArtifactId', label: 'Revealed judgment', value: defaults?.revealedJudgmentArtifactId ?? '', required: false, multiline: false, hint: 'Revealed judgment artifact id for route decisions.' },
      { id: 'routeDecisionArtifactId', label: 'Route decision', value: defaults?.routeDecisionArtifactId ?? '', required: false, multiline: false, hint: 'Saved leave-unchanged or applied-winner route-decision receipt id.' },
      { id: 'routeDecision', label: 'Decision label', value: defaults?.routeDecision ?? '', required: false, multiline: false, hint: 'left-unchanged or applied-winner when known.' },
      { id: 'handoffArtifactId', label: 'Reviewer handoff', value: defaults?.handoffArtifactId ?? '', required: false, multiline: false, hint: 'Reviewer handoff artifact id.' },
      { id: 'handoffArchiveArtifactId', label: 'Handoff archive', value: defaults?.handoffArchiveArtifactId ?? '', required: false, multiline: false, hint: 'Final reviewer handoff ZIP artifact id.' },
      { id: 'relatedArtifactIds', label: 'Related artifacts', value: defaults?.relatedArtifactIds.join('\n') ?? '', required: false, multiline: true, hint: 'Comma- or newline-separated source, export, attachment, receipt, or evidence artifact ids.' },
      { id: 'summary', label: 'Summary', value: defaults?.summary ?? '', required: false, multiline: false, hint: 'Short packet summary shown in list and timeline views.' },
      { id: 'confirm', label: 'Confirm save', value: 'no', required: true, multiline: false, hint: 'Type yes to save this packet preset.' },
    ],
  };
}

export function createAgentDocumentReviewPacketPresetRefreshEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-preset-refresh',
    mode: 'create',
    title: 'Refresh Review Packet Preset',
    selectedFieldIndex: 0,
    message: 'Save a new preset artifact from an existing stale preset using its freshness recommendations. This keeps the source preset as audit history and does not change documents, model routing, handoffs, or archives.',
    fields: [
      { id: 'artifactId', label: 'Preset artifact id', value: '', required: true, multiline: false, hint: 'Existing review packet preset artifact id from list/show output.' },
      { id: 'name', label: 'New preset name', value: '', required: false, multiline: false, hint: 'Optional. Defaults to the old preset name plus "refreshed".' },
      { id: 'summary', label: 'New summary', value: '', required: false, multiline: false, hint: 'Optional. Defaults to the old summary with stale ids replaced when possible.' },
      { id: 'confirm', label: 'Confirm refresh', value: 'no', required: true, multiline: false, hint: 'Type yes to refresh this packet preset.' },
    ],
  };
}

export function createAgentDocumentReviewPacketShareEditor(
  defaults: AgentWorkspaceReviewPacketDefaults | null = null,
): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-share',
    mode: 'create',
    title: 'Share Review Packet',
    selectedFieldIndex: 0,
    message: 'Share one saved reviewer handoff ZIP archive through a configured target. The tool validates the archive, includes packet evidence ids, and attaches the ZIP where the surface carries attachments; otherwise the message names it.',
    fields: [
      { id: 'archiveArtifactId', label: 'Archive artifact id', value: defaults?.handoffArchiveArtifactId ?? '', required: true, multiline: false, hint: defaults?.handoffArchiveArtifactId ? `Default from latest packet archive. Packet default: ${defaults.summary}.` : 'Saved reviewer handoff ZIP artifact id from the final archive step.' },
      { id: 'title', label: 'Title', value: 'GoodVibes Agent review packet', required: false, multiline: false, hint: 'Optional delivery title.' },
      { id: 'message', label: 'Message', value: '', required: false, multiline: true, hint: 'Optional note. The tool appends archive evidence, counts, ids, and export route automatically.' },
      { id: 'channel', label: 'Channel target', value: '', required: false, multiline: false, hint: 'Optional surface[:route][ | label], such as slack:C123 | Ops. Fill exactly one target field.' },
      { id: 'route', label: 'Route target', value: '', required: false, multiline: false, hint: 'Optional id of a bound route, or route id | label. Fill exactly one target field.' },
      { id: 'webhook', label: 'Webhook URL', value: '', required: false, multiline: false, hint: 'Optional http(s) webhook target. Fill exactly one target field.' },
      { id: 'confirm', label: 'Confirm share', value: 'no', required: true, multiline: false, hint: 'Type yes to share this review packet.' },
    ],
  };
}

function readList(value: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function optionalField(readField: AgentWorkspaceFieldReader, fieldId: string): string | undefined {
  const value = readField(fieldId).trim();
  return value ? value : undefined;
}

export function buildAgentDocumentReviewerReadinessToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentDocumentReviewerReadinessToolArgs {
  return {
    mode: 'document_ops_lane',
    laneId: 'reviewer_readiness',
    includeParameters: isAffirmative(readField('includeRoutes')),
  };
}

export function buildAgentDocumentReviewPacketWizardToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentDocumentReviewerReadinessToolArgs {
  return {
    mode: 'document_ops_lane',
    laneId: 'review_packet_wizard',
    includeParameters: isAffirmative(readField('includeRoutes')),
  };
}

export function buildAgentDocumentReviewPacketPresetToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketPresetToolArgs {
  const documentId = optionalField(readField, 'documentId');
  const documentTitle = optionalField(readField, 'documentTitle');
  const documentExportArtifactId = optionalField(readField, 'documentExportArtifactId');
  const comparisonArtifactId = optionalField(readField, 'comparisonArtifactId');
  const judgmentArtifactId = optionalField(readField, 'judgmentArtifactId');
  const revealedJudgmentArtifactId = optionalField(readField, 'revealedJudgmentArtifactId');
  const routeDecisionArtifactId = optionalField(readField, 'routeDecisionArtifactId');
  const routeDecision = optionalField(readField, 'routeDecision');
  const handoffArtifactId = optionalField(readField, 'handoffArtifactId');
  const handoffArchiveArtifactId = optionalField(readField, 'handoffArchiveArtifactId');
  const summary = optionalField(readField, 'summary');
  return {
    mode: 'save',
    name: readField('name').trim() || 'Reviewer packet preset',
    ...(documentId ? { documentId } : {}),
    ...(documentTitle ? { documentTitle } : {}),
    ...(documentExportArtifactId ? { documentExportArtifactId } : {}),
    ...(comparisonArtifactId ? { comparisonArtifactId } : {}),
    ...(judgmentArtifactId ? { judgmentArtifactId } : {}),
    ...(revealedJudgmentArtifactId ? { revealedJudgmentArtifactId } : {}),
    ...(routeDecisionArtifactId ? { routeDecisionArtifactId } : {}),
    ...(routeDecision ? { routeDecision } : {}),
    ...(handoffArtifactId ? { handoffArtifactId } : {}),
    ...(handoffArchiveArtifactId ? { handoffArchiveArtifactId } : {}),
    relatedArtifactIds: readList(readField('relatedArtifactIds')),
    ...(summary ? { summary } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}

export function buildAgentDocumentReviewPacketPresetRefreshToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketPresetRefreshToolArgs {
  const name = optionalField(readField, 'name');
  const summary = optionalField(readField, 'summary');
  return {
    mode: 'refresh',
    artifactId: readField('artifactId').trim(),
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}

export function buildAgentDocumentReviewPacketShareToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketShareToolArgs {
  const title = optionalField(readField, 'title');
  const message = optionalField(readField, 'message');
  const channel = optionalField(readField, 'channel');
  const route = optionalField(readField, 'route');
  const webhook = optionalField(readField, 'webhook');
  return {
    archiveArtifactId: readField('archiveArtifactId').trim(),
    ...(title ? { title } : {}),
    ...(message ? { message } : {}),
    ...(channel ? { channel } : {}),
    ...(route ? { route } : {}),
    ...(webhook ? { webhook } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}
