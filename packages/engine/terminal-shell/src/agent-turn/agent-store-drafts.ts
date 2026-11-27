/**
 * The acts on your saved artifacts and document drafts
 * (capabilities/builtin/artifacts.ts, documents.ts), done by the daemon. Each
 * is one call of the Agent tool that does it in a turn (`agent_artifacts`,
 * `agent_documents`, `agent_review_packet_presets`,
 * `agent_review_packet_share`), run as the owner's confirmed act on the
 * daemon's artifact store and the asking program's project; the lists also
 * answer their rows as facts, for a screen or a script.
 */
import { CapabilityRefusal, type ActionValues } from '@goodvibes/engine/platform/platform/capabilities';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import { UNTRUSTED_ARTIFACT_NOTICE } from './artifacts-tool.js';
import { AgentDocumentRegistry } from './document-registry.js';
import type { AgentDocumentRecord } from './document-registry-types.js';
import { given, positiveNumber, splitWords, storeStep, type StoreAct, type StoreActContext } from './agent-store-common.js';
import {
  formatReviewPacketSteps, formatReviewPacketTimeline, formatReviewReadiness, readPacketArtifacts, readPacketDocuments, reviewPacketOf,
} from './review-packet-report.js';

function artifactFacts(artifact: ArtifactDescriptor) {
  const purpose = typeof artifact.metadata?.['purpose'] === 'string' ? artifact.metadata['purpose'] as string : undefined;
  return {
    id: artifact.id, name: artifact.filename ?? artifact.id, kind: artifact.kind, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes,
    createdAt: new Date(artifact.createdAt).toISOString(), state: artifact.kind,
    ...(artifact.sourceUri ? { source: artifact.sourceUri } : {}), ...(purpose ? { purpose } : {}),
  };
}

/** The saved artifacts the list's filters keep, newest first, as facts. */
function listedArtifacts(context: StoreActContext, values: ActionValues) {
  const words = (values.words ?? '').trim().toLowerCase();
  const has = (field: string | undefined, part: string | undefined): boolean => !part || (field ?? '').toLowerCase().includes(part.toLowerCase());
  const kept = storeStep(() => context.artifacts.list(Number.MAX_SAFE_INTEGER)).map(artifactFacts).filter((artifact) =>
    (!values.kind || artifact.kind === values.kind) && has(artifact.mimeType, values.mimeType) && has(artifact.purpose, values.purpose) && has(artifact.source, values.source)
    && (!words || [artifact.name, artifact.kind, artifact.mimeType, artifact.source, artifact.purpose].some((field) => (field ?? '').toLowerCase().includes(words))));
  const skipped = Number(values.from ?? '0');
  const from = Number.isFinite(skipped) && skipped > 0 ? Math.trunc(skipped) : 0;
  return kept.slice(from, from + (positiveNumber(values.limit) ?? 25));
}

const documentsOf = (context: StoreActContext): AgentDocumentRegistry => AgentDocumentRegistry.fromShellPaths(context.shellPaths);

function documentFacts(document: AgentDocumentRecord) {
  return {
    id: document.id, title: document.title, state: document.status, status: document.status, tags: [...document.tags], versions: document.versionCount,
    updatedAt: document.updatedAt, createdAt: document.createdAt, body: document.body,
    comments: document.comments.map((comment) => ({ id: comment.id, body: comment.body, state: comment.status })),
    suggestions: document.suggestions.map((suggestion) => ({ id: suggestion.id, summary: suggestion.summary || suggestion.title, state: suggestion.status })),
    attachments: document.attachments.length,
  };
}

/** The review packet of the asking program's project: its drafts and the daemon's saved artifacts. */
function packetOf(context: StoreActContext) {
  return reviewPacketOf({
    documents: readPacketDocuments(() => documentsOf(context).list()),
    artifacts: readPacketArtifacts({ list: (limit?: number) => context.artifacts.list(limit) }),
    artifactsListable: true,
  });
}

/** One tool call; its printed answer is the act's words. */
async function tool(context: StoreActContext, name: string, args: Record<string, unknown>, what: string, data?: Readonly<Record<string, unknown>>) {
  const text = await context.tool(name, args, what);
  return { text, ...(data ? { data } : {}) };
}

/** The model's tool leads a read with a warning to the model about text it did not write; a person is shown the read. */
function withoutModelWarning(text: string): string {
  const warning = `${UNTRUSTED_ARTIFACT_NOTICE}\n`;
  return text.startsWith(warning) ? text.slice(warning.length) : text;
}

/** A change to a draft: one call of agent_documents in `mode`. */
function draftChange(mode: string, label: string, args: (values: ActionValues) => Record<string, unknown>): StoreAct {
  return async (values, context) => {
    const text = await context.tool('agent_documents', { mode, ...args(values), confirm: true, explicitUserRequest: `${label}: ${values.document ?? values.title ?? ''}` }, label.toLowerCase());
    const id = values.document;
    const document = id ? storeStep(() => documentsOf(context).get(id)) : null;
    return { text, ...(document ? { data: { document: documentFacts(document) } } : {}) };
  };
}

export const DRAFT_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'artifacts.list'(values, context) {
    const limit = positiveNumber(values.limit);
    const skipped = Number(values.from ?? '0');
    const from = Number.isFinite(skipped) && skipped > 0 ? Math.trunc(skipped) : 0;
    const listed = await tool(context, 'agent_artifacts', { mode: 'list', ...(values.words ? { query: values.words } : {}), ...given(values, 'kind', 'mimeType', 'purpose', 'source'), ...(limit ? { limit } : {}), ...(from ? { offset: from } : {}) },
      'list saved artifacts', { artifacts: listedArtifacts(context, values) });
    return { ...listed, text: withoutModelWarning(listed.text) };
  },
  async 'artifacts.show'(values, context) {
    const previewBytes = positiveNumber(values.bytes);
    const found = storeStep(() => context.artifacts.list(Number.MAX_SAFE_INTEGER)).find((artifact) => artifact.id === values.artifact);
    const shown = await tool(context, 'agent_artifacts', { mode: 'show', artifactId: values.artifact!, includeContent: values.preview !== 'no', ...(previewBytes ? { previewBytes } : {}) },
      `show artifact ${values.artifact}`, found ? { artifact: artifactFacts(found) } : undefined);
    return { ...shown, text: withoutModelWarning(shown.text) };
  },
  /** A turn's artifact (media, a comparison, a research report) saved by the daemon in its one store. */
  async 'artifacts.save'(values, context) {
    let metadata: Record<string, unknown> | undefined;
    if (values.metadata) {
      try {
        const parsed: unknown = JSON.parse(values.metadata);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch { throw new CapabilityRefusal('The artifact\'s details are not JSON; nothing was saved.'); }
    }
    const retention = values.retention ? Number(values.retention) : Number.NaN;
    const created = await context.artifacts.create({
      ...(values.encoding === 'base64' ? { dataBase64: values.content ?? '' } : { text: values.content ?? '' }),
      ...(values.kind ? { kind: values.kind as ArtifactDescriptor['kind'] } : {}),
      ...(values.mimeType ? { mimeType: values.mimeType } : {}),
      ...(values.filename ? { filename: values.filename } : {}),
      ...(values.source ? { sourceUri: values.source } : {}),
      ...(Number.isFinite(retention) && retention > 0 ? { retentionMs: retention } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return { text: `Saved ${created.filename ?? created.id} (${created.mimeType}, ${created.sizeBytes} bytes) as artifact ${created.id}.`, data: { artifact: created } };
  },
  async 'artifacts.export'(values, context) {
    return tool(context, 'agent_artifacts', { mode: 'export', artifactId: values.artifact!, destinationPath: values.path!, overwrite: values.overwrite === 'yes', confirm: true, explicitUserRequest: `Copy artifact ${values.artifact} to ${values.path}.` },
      `copy artifact ${values.artifact} to ${values.path}`, { artifact: values.artifact, path: values.path });
  },
  async 'artifacts.package'(values, context) {
    return tool(context, 'agent_artifacts', {
      mode: values.format === 'zip' ? 'archive' : 'package', artifactIds: splitWords(values.artifacts), destinationPath: values.path!,
      overwrite: values.overwrite === 'yes', confirm: true, explicitUserRequest: `Copy artifacts ${values.artifacts} into ${values.path}.`,
    }, `copy artifacts into ${values.path}`, { artifacts: splitWords(values.artifacts), path: values.path });
  },
  async 'documents.list'(values, context) {
    const limit = positiveNumber(values.limit);
    const registry = documentsOf(context);
    const matches = storeStep(() => values.words ? registry.search(values.words) : registry.list());
    return tool(context, 'agent_documents', { mode: 'list', ...(values.words ? { query: values.words } : {}), ...(limit ? { limit } : {}) },
      'list document drafts', { documents: matches.slice(0, limit ?? 20).map(documentFacts) });
  },
  async 'documents.show'(values, context) {
    const document = storeStep(() => documentsOf(context).get(values.document!));
    if (!document) throw new CapabilityRefusal(`No draft ${values.document}.`, 'Your drafts are listed in Memory and knowledge.', 'NOT_FOUND');
    return tool(context, 'agent_documents', { mode: 'show', documentId: values.document!, includeVersions: values.versions !== 'no' }, `show draft ${values.document}`, { document: documentFacts(document) });
  },
  'documents.create': async (values, context) => {
    const text = await context.tool('agent_documents', {
      mode: 'create', title: values.title, body: values.body, tags: values.tags ? splitWords(values.tags) : ['document'], changeSummary: values.note || 'Initial draft.',
      confirm: true, explicitUserRequest: `Write a new draft: ${values.title ?? ''}`,
    }, 'write a new draft');
    const made = storeStep(() => documentsOf(context).get(values.title!));
    return { text, ...(made ? { data: { document: documentFacts(made) } } : {}) };
  },
  'documents.revise': draftChange('update', 'Revise a draft', (values) => ({ documentId: values.document, ...given(values, 'title', 'body', 'status'), ...(values.tags ? { tags: splitWords(values.tags) } : {}), changeSummary: values.note || 'Updated draft.' })),
  'documents.mark-reviewed': draftChange('review', 'Mark a draft reviewed', (values) => ({ documentId: values.document })),
  'documents.comment': draftChange('comment', 'Comment on a draft', (values) => ({ documentId: values.document, comment: values.comment })),
  'documents.resolve-comment': draftChange('resolveComment', 'Resolve a comment', (values) => ({ documentId: values.document, commentId: values.comment })),
  'documents.suggest': draftChange('suggest', 'Suggest a change to a draft', (values) => ({
    documentId: values.document, body: values.body, ...given(values, 'title', 'status'), ...(values.tags ? { tags: splitWords(values.tags) } : {}),
    changeSummary: values.note || 'Suggested revision.', ...(values.why ? { suggestionRationale: values.why } : {}),
  })),
  'documents.accept-suggestion': draftChange('acceptSuggestion', 'Take a suggested change', (values) => ({ documentId: values.document, suggestionId: values.suggestion })),
  'documents.reject-suggestion': draftChange('rejectSuggestion', 'Leave a suggested change', (values) => ({ documentId: values.document, suggestionId: values.suggestion })),
  'documents.insert-artifact': draftChange('insertArtifact', 'Put an artifact into a draft', (values) => ({
    documentId: values.document, artifactId: values.artifact, placement: values.placement || 'append', ...(values.heading ? { sectionTitle: values.heading } : {}),
    includeContent: values.content !== 'no', changeSummary: values.note || 'Inserted saved artifact.',
  })),
  'documents.attach-artifact': draftChange('attachArtifact', 'Attach an artifact to a draft', (values) => ({
    documentId: values.document, artifactId: values.artifact, ...(values.name ? { attachmentLabel: values.name } : {}), ...(values.why ? { attachmentNote: values.why } : {}),
  })),
  'documents.export': draftChange('export', 'Save a draft as an artifact', (values) => ({ documentId: values.document })),
  async 'documents.save-preset'(values, context) {
    return tool(context, 'agent_review_packet_presets', {
      mode: 'save', name: values.name,
      ...(values.document ? { documentId: values.document } : {}), ...(values.title ? { documentTitle: values.title } : {}),
      ...(values.export ? { documentExportArtifactId: values.export } : {}), ...(values.comparison ? { comparisonArtifactId: values.comparison } : {}),
      ...(values.judgment ? { judgmentArtifactId: values.judgment } : {}), ...(values.revealed ? { revealedJudgmentArtifactId: values.revealed } : {}),
      ...(values.decision ? { routeDecisionArtifactId: values.decision } : {}), ...(values.outcome ? { routeDecision: values.outcome } : {}),
      ...(values.handoff ? { handoffArtifactId: values.handoff } : {}), ...(values.archive ? { handoffArchiveArtifactId: values.archive } : {}),
      relatedArtifactIds: splitWords(values.related), ...(values.summary ? { summary: values.summary } : {}),
      confirm: true, explicitUserRequest: `Save review packet preset ${values.name}.`,
    }, `save review packet preset ${values.name}`);
  },
  async 'documents.refresh-preset'(values, context) {
    return tool(context, 'agent_review_packet_presets', {
      mode: 'refresh', artifactId: values.preset, ...given(values, 'name', 'summary'), confirm: true, explicitUserRequest: `Refresh review packet preset ${values.preset}.`,
    }, `refresh review packet preset ${values.preset}`);
  },
  // The review packet, from this project's drafts and the daemon's saved artifacts, each read once.
  async 'documents.readiness'(_values, context) {
    const packet = packetOf(context);
    return { text: formatReviewReadiness(packet.readiness), data: { readiness: packet.readiness } };
  },
  async 'documents.packet-steps'(_values, context) {
    const packet = packetOf(context);
    return { text: formatReviewPacketSteps(packet.wizard), data: { steps: packet.wizard } };
  },
  async 'documents.timeline'(_values, context) {
    const packet = packetOf(context);
    return { text: formatReviewPacketTimeline(packet.timeline), data: { timeline: packet.timeline } };
  },
  async 'documents.share-packet'(values, context) {
    return tool(context, 'agent_review_packet_share', {
      archiveArtifactId: values.archive, [values.via === 'route' ? 'route' : values.via === 'webhook' ? 'webhook' : 'channel']: values.to,
      ...given(values, 'title', 'message'), confirm: true, explicitUserRequest: `Send review packet ${values.archive} to ${values.to}.`,
    }, `send review packet ${values.archive}`);
  },
};
