import { randomUUID } from 'node:crypto';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { agentArtifactEffectGuard, captureAgentArtifactSource } from './artifact-effect.js';
import { DEFAULT_LIST_LIMIT, MAX_FRESHNESS_ARTIFACT_SCAN, MAX_LIST_LIMIT, REVIEW_PACKET_PRESET_SCHEMA, auditPresetFreshness, buildPresetRecord, clamp, compactText, defaultPacketSummary, freshnessReferences, isPresetArtifact, packetFromMetadata, parseMode, parsePresetBody, presetCreateInput, readMetadataString, readNumber, readString, sourceArtifactId, type AgentReviewPacketPresetArtifactStore, type AgentReviewPacketPresetsToolArgs, type LoadedReviewPacketPreset, type ReviewPacketFreshnessAudit, type ReviewPacketPresetPacket, type ReviewPacketPresetRecord } from './review-packet-presets-core.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { toolErrorText } from './tool-error-text.js';
function formatPacketLines(packet: ReviewPacketPresetPacket): readonly string[] {
  return [
    `  summary ${packet.summary}`,
    packet.documentId ? `  document ${packet.documentId}${packet.documentTitle ? ` (${packet.documentTitle})` : ''}` : '',
    packet.documentExportArtifactId ? `  documentExport ${packet.documentExportArtifactId}` : '',
    packet.comparisonArtifactId ? `  comparison ${packet.comparisonArtifactId}` : '',
    packet.judgmentArtifactId ? `  judgment ${packet.judgmentArtifactId}` : '',
    packet.revealedJudgmentArtifactId ? `  revealedJudgment ${packet.revealedJudgmentArtifactId}` : '',
    packet.routeDecisionArtifactId ? `  routeDecision ${packet.routeDecisionArtifactId}${packet.routeDecision ? ` (${packet.routeDecision})` : ''}` : '',
    packet.handoffArtifactId ? `  handoff ${packet.handoffArtifactId}` : '',
    packet.handoffArchiveArtifactId ? `  handoffArchive ${packet.handoffArchiveArtifactId}` : '',
    `  related ${packet.relatedArtifactIds.length > 0 ? packet.relatedArtifactIds.join(', ') : '(none)'}`,
  ].filter(Boolean);
}

function formatSaveResult(descriptor: ArtifactDescriptor, record: ReviewPacketPresetRecord, audit: ReviewPacketFreshnessAudit): string {
  return [
    'Review packet preset saved',
    `  artifact ${descriptor.id}`,
    `  preset ${record.presetId}`,
    `  name ${record.name}`,
    ...formatPacketLines(record.packet),
    // A typo'd id is saved as given; this is where it shows up, not on a later read.
    ...formatFreshnessLines(audit),
    `  inspect agent_review_packet_presets mode:"show" artifactId:"${descriptor.id}"`,
    '  list agent_review_packet_presets mode:"list"',
    '  policy local preset artifact only; documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function packetReferenceFingerprint(packet: ReviewPacketPresetPacket): string {
  return JSON.stringify({
    documentId: packet.documentId ?? '',
    documentTitle: packet.documentTitle ?? '',
    documentExportArtifactId: packet.documentExportArtifactId ?? '',
    comparisonArtifactId: packet.comparisonArtifactId ?? '',
    judgmentArtifactId: packet.judgmentArtifactId ?? '',
    revealedJudgmentArtifactId: packet.revealedJudgmentArtifactId ?? '',
    routeDecisionArtifactId: packet.routeDecisionArtifactId ?? '',
    routeDecision: packet.routeDecision ?? '',
    handoffArtifactId: packet.handoffArtifactId ?? '',
    handoffArchiveArtifactId: packet.handoffArchiveArtifactId ?? '',
    relatedArtifactIds: packet.relatedArtifactIds,
  });
}

function hasRefreshableReplacements(audit: ReviewPacketFreshnessAudit): boolean {
  return audit.missing.some((missing) => Boolean(missing.replacementId)) || audit.superseded.length > 0;
}

function unresolvedFreshnessCount(audit: ReviewPacketFreshnessAudit): number {
  return audit.missing.filter((missing) => !missing.replacementId).length + audit.dependentOnReplaced.length;
}

function updateSummaryReferences(summary: string, audit: ReviewPacketFreshnessAudit): string {
  let updated = summary;
  const replace = (from: string, to: string | undefined): void => {
    if (!to || !from || from === to) return;
    updated = updated.split(from).join(to);
  };
  for (const missing of audit.missing) replace(missing.id, missing.replacementId);
  for (const superseded of audit.superseded) replace(superseded.id, superseded.replacementId);
  return updated.trim();
}

function refreshedPacket(
  original: ReviewPacketPresetPacket,
  audit: ReviewPacketFreshnessAudit,
  explicitSummary: string,
): ReviewPacketPresetPacket {
  const recommended = audit.recommendedPacket;
  const summary = explicitSummary
    || updateSummaryReferences(original.summary, audit)
    || defaultPacketSummary(recommended);
  return { ...recommended, summary };
}

function buildRefreshRecord(input: {
  readonly args: AgentReviewPacketPresetsToolArgs;
  readonly loaded: LoadedReviewPacketPreset;
  readonly audit: ReviewPacketFreshnessAudit;
  readonly packet: ReviewPacketPresetPacket;
}): ReviewPacketPresetRecord {
  const explicitUserRequest = readString(input.args.explicitUserRequest);
  const oldName = input.loaded.body?.name
    || readMetadataString(input.loaded.descriptor.metadata, 'name')
    || input.loaded.descriptor.filename
    || input.loaded.descriptor.id;
  const oldPresetId = input.loaded.body?.presetId || readMetadataString(input.loaded.descriptor.metadata, 'presetId');
  const requestedName = readString(input.args.name);
  return {
    schema: REVIEW_PACKET_PRESET_SCHEMA,
    schemaVersion: 1,
    presetId: `packet_preset_${randomUUID()}`,
    name: requestedName || `${oldName} refreshed`,
    createdAt: new Date().toISOString(),
    explicitUserRequest,
    packet: refreshedPacket(input.packet, input.audit, readString(input.args.summary)),
    refresh: {
      sourceArtifactId: input.loaded.descriptor.id,
      ...(oldPresetId ? { sourcePresetId: oldPresetId } : {}),
      missingCount: input.audit.missing.length,
      supersededCount: input.audit.superseded.length,
      unresolvedCount: unresolvedFreshnessCount(input.audit),
    },
    policy: {
      effect: 'save-local-preset-artifact-only',
      documentsChanged: false,
      modelRouteChanged: false,
      handoffArchiveCreated: false,
    },
  };
}

function formatRefreshResult(
  descriptor: ArtifactDescriptor,
  source: LoadedReviewPacketPreset,
  audit: ReviewPacketFreshnessAudit,
  record: ReviewPacketPresetRecord,
): string {
  return [
    'Review packet preset refreshed',
    `  artifact ${descriptor.id}`,
    `  refreshedFrom ${source.descriptor.id}`,
    `  preset ${record.presetId}`,
    `  name ${record.name}`,
    ...formatPacketLines(record.packet),
    `  freshness repaired ${audit.missing.filter((missing) => Boolean(missing.replacementId)).length + audit.superseded.length}; unresolved ${unresolvedFreshnessCount(audit)}`,
    `  inspect agent_review_packet_presets mode:"show" artifactId:"${descriptor.id}"`,
    '  policy local preset artifact only; source preset, documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function formatAlreadyCurrent(source: LoadedReviewPacketPreset, audit: ReviewPacketFreshnessAudit): string {
  return [
    'Review packet preset already current',
    `  artifact ${source.descriptor.id}`,
    `  ${formatFreshnessSummary(audit)}`,
    '  no new preset artifact created',
    '  policy documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function formatFreshnessSummary(audit: ReviewPacketFreshnessAudit): string {
  if (!audit.available) return 'freshness unchecked; artifact list unavailable';
  if (audit.status === 'current') return `freshness current; checked ${audit.scannedArtifacts} artifact(s)`;
  return `freshness needs-review; missing ${audit.missing.length}; newer ${audit.superseded.length}${audit.dependentOnReplaced.length > 0 ? `; unresolved ${audit.dependentOnReplaced.length}` : ''}; checked ${audit.scannedArtifacts} artifact(s)`;
}

function formatFreshnessLines(audit: ReviewPacketFreshnessAudit): readonly string[] {
  if (!audit.available) return ['  freshness unchecked; artifact list unavailable'];
  const lines = [`  ${formatFreshnessSummary(audit)}`];
  for (const missing of audit.missing.slice(0, 8)) {
    lines.push(
      `  missing ${missing.label} ${missing.id}${missing.replacementId ? `; recommended ${missing.replacementId} (${missing.reason ?? 'matching artifact'})` : ''}`,
    );
  }
  for (const superseded of audit.superseded.slice(0, 8)) {
    lines.push(`  newer ${superseded.label} ${superseded.id} -> ${superseded.replacementId} (${superseded.reason})`);
  }
  for (const dependent of audit.dependentOnReplaced.slice(0, 8)) {
    lines.push(`  unresolved ${dependent.label} ${dependent.id} ${dependent.reason}; it was not replaced and may not match the newer evidence`);
  }
  const shownMissing = Math.min(audit.missing.length, 8);
  const shownSuperseded = Math.min(audit.superseded.length, 8);
  const shownDependent = Math.min(audit.dependentOnReplaced.length, 8);
  const hidden = Math.max(0, audit.missing.length + audit.superseded.length + audit.dependentOnReplaced.length - shownMissing - shownSuperseded - shownDependent);
  if (hidden > 0) lines.push(`  freshness omitted ${hidden} additional issue(s)`);
  if (audit.status === 'needs-review') {
    lines.push('  policy inspect freshness before reuse; recommended routes below use newer ids when a safe replacement was found');
  }
  return lines;
}

function formatList(
  artifacts: readonly ArtifactDescriptor[],
  total: number,
  allArtifacts: readonly ArtifactDescriptor[] | null,
  store?: AgentReviewPacketPresetArtifactStore,
  cappedAt: number | null = null,
  supersededCount = 0,
): string {
  // The store is asked for its newest N artifacts; when it filled that window, older presets may exist unseen.
  const windowNote = cappedAt === null ? '' : ` (searched the newest ${cappedAt} artifacts only; older presets were not searched)`;
  // A preset another preset was refreshed from is replaced by it; it is counted, not listed.
  const hidden = supersededCount > 0 ? `  hidden ${supersededCount} preset(s) replaced by a refresh; show one with mode:"show" artifactId:"..."` : '';
  if (artifacts.length === 0) {
    return [
      'Saved review packet presets',
      `  none found${windowNote}`,
      hidden,
      '  save agent_review_packet_presets mode:"save" name:"..."',
    ].filter(Boolean).join('\n');
  }
  return [
    'Saved review packet presets',
    `  shown ${artifacts.length}/${total}${windowNote}`,
    hidden,
    ...artifacts.flatMap((artifact) => {
      const packet = packetFromMetadata(artifact);
      const audit = auditPresetFreshness({ packet, descriptor: artifact, artifacts: allArtifacts, store });
      const name = readMetadataString(artifact.metadata, 'name') || artifact.filename || artifact.id;
      const source = sourceArtifactId(packet) || '(no source)';
      return [
        `  - ${artifact.id}: ${name}`,
        `    summary ${compactText(packet.summary, 120)}`,
        `    document ${packet.documentId ?? '(none)'}; source ${source}; handoff ${packet.handoffArtifactId ?? '(none)'}; archive ${packet.handoffArchiveArtifactId ?? '(none)'}; related ${packet.relatedArtifactIds.length}`,
        `    ${formatFreshnessSummary(audit)}`,
        audit.status === 'needs-review' && hasRefreshableReplacements(audit)
          ? `    refresh agent_review_packet_presets mode:"refresh" artifactId:"${artifact.id}"`
          : '',
        `    inspect agent_review_packet_presets mode:"show" artifactId:"${artifact.id}"`,
      ].filter(Boolean);
    }),
  ].filter(Boolean).join('\n');
}

function formatShow(loaded: LoadedReviewPacketPreset, audit: ReviewPacketFreshnessAudit): string {
  const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
  const routePacket = audit.recommendedPacket;
  const name = loaded.body?.name || readMetadataString(loaded.descriptor.metadata, 'name') || loaded.descriptor.filename || loaded.descriptor.id;
  const presetId = loaded.body?.presetId || readMetadataString(loaded.descriptor.metadata, 'presetId') || loaded.descriptor.id;
  const sourceId = sourceArtifactId(routePacket);
  const related = JSON.stringify(routePacket.relatedArtifactIds);
  return [
    'Saved review packet preset',
    `  artifact ${loaded.descriptor.id}`,
    `  preset ${presetId}`,
    `  name ${name}`,
    ...formatPacketLines(packet),
    ...formatFreshnessLines(audit),
    loaded.body?.explicitUserRequest ? `  explicitUserRequest ${compactText(loaded.body.explicitUserRequest, 140)}` : '',
    sourceId ? `  sideBySide agent_model_compare mode:"sideBySide" artifactId:"${sourceId}" relatedArtifactIds:${related}` : '',
    sourceId ? `  handoff agent_model_compare mode:"handoff" artifactId:"${sourceId}" relatedArtifactIds:${related}` : '',
    routePacket.revealedJudgmentArtifactId ? `  routeDecision agent_model_compare mode:"routeDecision" artifactId:"${routePacket.revealedJudgmentArtifactId}" decision:"left-unchanged"` : '',
    routePacket.handoffArtifactId ? `  archive agent_model_compare mode:"handoffArchive" artifactId:"${routePacket.handoffArtifactId}"` : '',
    routePacket.handoffArchiveArtifactId ? `  inspectArchive agent_artifacts mode:"show" artifactId:"${routePacket.handoffArchiveArtifactId}"` : '',
    audit.status === 'needs-review' && hasRefreshableReplacements(audit)
      ? `  refreshPreset agent_review_packet_presets mode:"refresh" artifactId:"${loaded.descriptor.id}"`
      : '',
    '  policy read-only inspection; reuse routes require their own recorded effect admission',
  ].filter(Boolean).join('\n');
}

async function loadPresetArtifact(
  store: AgentReviewPacketPresetArtifactStore,
  artifactId: string,
): Promise<LoadedReviewPacketPreset | null> {
  if (store.readContent) {
    const { record, buffer } = await store.readContent(artifactId);
    if (!isPresetArtifact(record)) return null;
    return { descriptor: record, record, body: parsePresetBody(buffer) ?? undefined };
  }
  const descriptor = store.list?.(200).find((artifact) => artifact.id === artifactId) ?? null;
  if (!descriptor || !isPresetArtifact(descriptor)) return null;
  return { descriptor };
}

export function createAgentReviewPacketPresetsTool(
  artifactStore?: AgentReviewPacketPresetArtifactStore,
): Tool {
  return {
    definition: {
      name: 'agent_review_packet_presets',
      activity: { doing: 'Preparing', did: 'prepared', object: 'a review packet', objects: 'review packets' },
      description: 'Save and refresh reusable Document Ops packet presets.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['list', 'show', 'save', 'refresh', 'delete'],
            description: 'List, show, save, refresh or delete one review packet preset.',
          },
          artifactId: {
            type: 'string',
            description: 'Saved preset artifact id for show, refresh or delete mode.',
          },
          name: {
            type: 'string',
            description: 'Human-friendly preset name for save or refresh mode.',
          },
          documentId: {
            type: 'string',
            description: 'Agent document draft id captured by the preset.',
          },
          documentTitle: {
            type: 'string',
            description: 'Optional document title captured by the preset.',
          },
          documentExportArtifactId: {
            type: 'string',
            description: 'Exported document evidence artifact id.',
          },
          comparisonArtifactId: {
            type: 'string',
            description: 'Saved blind comparison artifact id.',
          },
          judgmentArtifactId: {
            type: 'string',
            description: 'Saved comparison judgment artifact id.',
          },
          revealedJudgmentArtifactId: {
            type: 'string',
            description: 'Revealed judgment artifact id for route decisions.',
          },
          routeDecisionArtifactId: {
            type: 'string',
            description: 'Saved route-decision receipt artifact id.',
          },
          routeDecision: {
            type: 'string',
            description: 'Route decision label such as left-unchanged.',
          },
          handoffArtifactId: {
            type: 'string',
            description: 'Reviewer handoff artifact id.',
          },
          handoffArchiveArtifactId: {
            type: 'string',
            description: 'Final reviewer handoff ZIP artifact id.',
          },
          relatedArtifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related evidence artifact ids to reuse.',
          },
          summary: {
            type: 'string',
            description: 'Short preset summary.',
          },
          limit: {
            type: 'number',
            description: 'Maximum presets to list.',
          },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions) => {
      const args = rawArgs;
      const assertCurrent = agentArtifactEffectGuard(rawArgs, executionOptions);
      try {
        const mode = parseMode(args.mode);
        if (mode === 'list') {
          if (!artifactStore?.list) return failure('Review packet preset list is unavailable because this runtime cannot list artifacts.');
          const limit = clamp(readNumber(args.limit, DEFAULT_LIST_LIMIT), 1, MAX_LIST_LIMIT);
          const window = Math.max(MAX_FRESHNESS_ARTIFACT_SCAN, limit * 4);
          const allArtifacts = artifactStore.list(window);
          const presets = allArtifacts.filter(isPresetArtifact);
          const replaced = new Set(presets.map(preset => readMetadataString(preset.metadata, 'refreshOfArtifactId')).filter(Boolean));
          const source = presets.filter(preset => !replaced.has(preset.id));
          const ordered = source.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
          return output(formatList(ordered.slice(0, limit), source.length, allArtifacts, artifactStore, allArtifacts.length >= window ? window : null, presets.length - source.length));
        }
        if (mode === 'show') {
          const artifactId = readString(args.artifactId);
          if (!artifactId) return failure('artifactId is required for mode:"show".');
          if (!artifactStore?.readContent && !artifactStore?.list) return failure('Review packet preset show is unavailable because this runtime cannot read or list artifacts.');
          const loaded = await loadPresetArtifact(artifactStore, artifactId);
          if (!loaded) return failure(`Unknown review packet preset artifact ${artifactId}. Use agent_review_packet_presets mode:"list" first.`);
          const allArtifacts = artifactStore.list?.(MAX_FRESHNESS_ARTIFACT_SCAN) ?? null;
          const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
          return output(formatShow(loaded, auditPresetFreshness({
            packet,
            descriptor: loaded.descriptor,
            artifacts: allArtifacts,
            store: artifactStore,
          })));
        }
        if (mode === 'delete') {
          assertCurrent();
          const artifactId = readString(args.artifactId);
          if (!artifactId) return failure('artifactId is required for mode:"delete".');
          if (!artifactStore?.delete || !artifactStore.get) return failure('Review packet preset delete is unavailable because this runtime cannot remove artifacts.');
          const preset = artifactStore.get(artifactId);
          if (!preset || !isPresetArtifact(preset)) return failure(`Nothing was deleted: ${artifactId} is not a saved review packet preset. Use agent_review_packet_presets mode:"list" first.`);
          assertCurrent();
          if (!artifactStore.delete(artifactId)) return failure(`Nothing was deleted: preset ${artifactId} was already gone.`);
          return output([
            'Deleted review packet preset',
            `  artifact ${artifactId}`,
            '  the artifacts it referenced were not touched',
          ].join('\n'));
        }
        if (mode === 'refresh') {
          assertCurrent();
          const artifactId = readString(args.artifactId);
          if (!artifactId) return failure('artifactId is required for mode:"refresh".');
          if (!artifactStore?.create) return failure('Review packet preset refresh is unavailable because this runtime did not provide an artifact store.');
          if (!artifactStore.readContent && !artifactStore.list) return failure('Review packet preset refresh is unavailable because this runtime cannot read or list artifacts.');
          if (!artifactStore.list) return failure('Review packet preset refresh is unavailable because this runtime cannot list artifacts for freshness checks.');
          const loaded = await loadPresetArtifact(artifactStore, artifactId);
          if (!loaded) return failure(`Unknown review packet preset artifact ${artifactId}. Use agent_review_packet_presets mode:"list" first.`);
          assertCurrent();
          const allArtifacts = artifactStore.list(MAX_FRESHNESS_ARTIFACT_SCAN);
          // A preset that was already refreshed answers with its successor; a second refresh would only duplicate it.
          const successor = allArtifacts.find(artifact => isPresetArtifact(artifact)
            && readMetadataString(artifact.metadata, 'refreshOfArtifactId') === loaded.descriptor.id);
          if (successor) {
            return output([
              'Review packet preset was already refreshed',
              `  preset ${loaded.descriptor.id} was refreshed as ${successor.id}; nothing new was saved`,
              `  inspect agent_review_packet_presets mode:"show" artifactId:"${successor.id}"`,
              `  refreshAgain agent_review_packet_presets mode:"refresh" artifactId:"${successor.id}"`,
            ].join('\n'));
          }
          const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
          const audit = auditPresetFreshness({
            packet,
            descriptor: loaded.descriptor,
            artifacts: allArtifacts,
            store: artifactStore,
          });
          if (audit.status === 'current') return output(formatAlreadyCurrent(loaded, audit));
          const record = buildRefreshRecord({ args, loaded, audit, packet });
          if (
            !hasRefreshableReplacements(audit)
            || packetReferenceFingerprint(packet) === packetReferenceFingerprint(record.packet)
          ) {
            return failure([
              'Review packet preset refresh could not find a safe replacement to save.',
              ...formatFreshnessLines(audit),
              'Inspect the preset and repair missing evidence manually before saving a new preset.',
            ].join('\n'));
          }
          // Guard what the new preset is built from: the preset itself and the artifacts the new packet names.
          const store = artifactStore;
          const index = new Map(allArtifacts.map(artifact => [artifact.id, artifact]));
          const guarded = [loaded.descriptor, ...freshnessReferences(record.packet)
            .map(reference => index.get(reference.id) ?? store.get?.(reference.id) ?? null)
            .filter((artifact): artifact is ArtifactDescriptor => artifact !== null)];
          const references = [...new Map(guarded.map(artifact => [artifact.id, artifact])).values()]
            .map(artifact => captureAgentArtifactSource(store, artifact));
          const check = () => { assertCurrent(); for (const reference of references) reference(); };
          check();
          const descriptor = await artifactStore.create(presetCreateInput(record), { signal: executionOptions?.signal, assertCurrent: check });
          return output(formatRefreshResult(descriptor, loaded, audit, record));
        }
        assertCurrent();
        if (!artifactStore?.create) return failure('Review packet preset save is unavailable because this runtime did not provide an artifact store.');
        const record = buildPresetRecord(args);
        // An id the store does not hold is refused before anything is written.
        const lookup = artifactStore.get?.bind(artifactStore);
        if (lookup) {
          const unknown = freshnessReferences(record.packet).filter(reference => !lookup(reference.id));
          if (unknown.length > 0) {
            return failure(`Nothing was saved: ${unknown.map(reference => `${reference.label} ${reference.id}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the artifact store. Check the ids with agent_artifacts mode:"list" and save again.`);
          }
        }
        const descriptor = await artifactStore.create(presetCreateInput(record), { signal: executionOptions?.signal, assertCurrent });
        // Once the store has written, the result is the save; the freshness read below only describes it.
        let audit: ReviewPacketFreshnessAudit;
        try {
          audit = auditPresetFreshness({ packet: record.packet, descriptor, artifacts: artifactStore.list?.(MAX_FRESHNESS_ARTIFACT_SCAN) ?? null, store: artifactStore });
        } catch {
          audit = auditPresetFreshness({ packet: record.packet, descriptor, artifacts: null, store: artifactStore });
        }
        return output(formatSaveResult(descriptor, record, audit));
      } catch (error) {
        return failure(toolErrorText(error));
      }
    },
  };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function registerAgentReviewPacketPresetsTool(
  registry: ToolRegistry,
  artifactStore?: AgentReviewPacketPresetArtifactStore,
): void {
  registry.register(createAgentReviewPacketPresetsTool(artifactStore));
}
