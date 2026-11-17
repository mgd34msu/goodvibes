/**
 * The Agent's turn, as both places that run one compose it: the Agent's own
 * process and a session the daemon hosts for the Agent (`originSurface:
 * 'agent'`). What lives here is what such a turn is made of and needs no
 * terminal: the operator policy, the capture contract and the vocabulary of the
 * tools it names, and the per-turn prompt composer with the stores it reads
 * (VIBE, project context, persona, skills, routines, reviewed memory) and its
 * receipt journal, and the Agent tools that need no terminal (`profile` and
 * `occasions`, over the daemon's own verbs).
 */
export { GOODVIBES_AGENT_OPERATOR_POLICY } from './operator-policy.js';
export {
  AGENT_CONVERSATIONAL_CAPTURE_POLICY,
  AGENT_CONVERSATIONAL_CAPTURE_TOOLS,
  missingConversationalCaptureTools,
  resolveAgentTurnCaptureAuthority,
} from './conversational-capture.js';
export * from './occasions-types.js';
export { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
export * from './capability-summary-prompt.js';
export * from './capability-types.js';
export * from './memory-prompt.js';
export * from './memory-safety.js';
export * from './persona-registry.js';
export * from './project-context-files.js';
export * from './prompt-context-receipt-journal.js';
export * from './prompt-context-receipts.js';
export * from './record-labels.js';
export * from './review-state.js';
export * from './routine-registry.js';
export * from './skill-registry.js';
export * from './skill-registry-types.js';
export * from './skill-standard.js';
export * from './store-change-stamp.js';
export * from './store-file.js';
export * from './vibe-file.js';
export * from './catalog-data.js';
export * from './home-path.js';
export * from './operator-contract-routes.js';
export * from './family-gateway.js';
export * from './family-remote.js';
export * from './profile-types.js';
export * from './profile-gateway.js';
export * from './profile-tool.js';
export * from './occasions-gateway.js';
// Not re-exported: its readString and readNumber; the review-packet presets export their own.
export { fail, isOutcome, ok, type AgentOccasionsToolDeps, type ToolOutcome } from './occasions-outcome.js';
export * from './occasions-reads.js';
export * from './occasions-tool.js';
export * from './local-state-admission.js';
export * from './hosted-turn.js';
export * from './read-modes.js';
export * from './note-registry.js';
export * from './review-authority.js';
export * from './memory-input-guard.js';
export * from './local-registry-admission.js';
// Not re-exported: the argument readers, which share their names with other tools' own.
export { readActivation, type AgentLocalRegistryToolArgs } from './local-registry-args.js';
export { handleMemory } from './local-registry-memory.js';
export { createAgentLocalRegistryTool, registerAgentLocalRegistryTool, type AgentLocalRegistryAction, type AgentLocalRegistryDomain } from './local-registry-tool.js';
export * from './catalog-ranking.js';
export * from './local-library-items.js';
export * from './personal-ops-data.js';
export * from './learning-curator-types.js';
export * from './learning-curation-store.js';
export * from './learning-curator-common.js';
export * from './learning-curator-consolidation.js';
export * from './learning-curator-source.js';
export * from './learning-curator-readings.js';
export * from './learning-curator-proposals.js';
export * from './learning-curator.js';
export * from './retained-guards.js';
export * from './personal-ops-ingress.js';
export * from './catalog-ingress.js';
// Not re-exported: the consolidation core's argument readers and record helpers, named like other tools' own.
export { writeReceipt, type AgentLearningConsolidationToolArgs, type LearningConsolidationReceipt } from './learning-consolidation-core.js';
export { createAgentLearningConsolidationTool, registerAgentLearningConsolidationTool } from './learning-consolidation-tool.js';
export * from './preview-text.js';
export * from './read-helpers.js';
export * from './effect-admission.js';
export * from './tool-error-text.js';
export * from './inventory-disclosure.js';
export * from './artifact-effect.js';
export * from './artifact-archive.js';
export * from './artifacts-tool.js';
export * from './document-registry-types.js';
export * from './document-registry.js';
export * from './documents-tool.js';
export * from './research-ledgers.js';
export * from './research-run-registry.js';
export * from './research-source-registry.js';
export * from './research-runs-tool.js';
export * from './research-sources-tool.js';
export * from './review-packet-presets-core.js';
export * from './review-packet-presets-tool.js';
export * from './provider-model.js';
export * from './payments-channel-guard.js';
export * from './schedule-delivery-targets.js';
export * from './channel-delivery.js';
export * from './media-generation.js';
export * from './notify-tool.js';
export * from './media-generate-tool.js';
export * from './review-packet-share-tool.js';
export * from './work-plan-tool.js';
// Agent Knowledge, research reports and model comparison. Not re-exported: the
// knowledge formatter's readString(record, key), the runtime's JsonRecord and
// the comparison helpers, whose names other modules here export too.
export { readFlag } from './tool-args.js';
export * from './markdown-fence.js';
export * from './model-reading.js';
export * from './research-report-input.js';
export * from './protected-research-report.js';
export {
  AGENT_HOSTED_RESEARCH_SCREENING_KEY,
  AGENT_HOSTED_RESEARCH_SCREENING_SETTING,
  createAgentCredentialReader,
  createAgentResearchSourceOwner,
  createAgentSettingsReader,
  type AgentResearchScreeningConfig,
  type AgentResearchScreeningCredentials,
  type AgentSettingsReader,
} from './research-source-screening.js';
export * from './research-report-tool.js';
export * from './model-compare-tool.js';
export * from './knowledge-methods.js';
export * from './knowledge-scope-alias.js';
export {
  formatAgentKnowledgeFailureKind,
  formatAsk,
  formatBatchIngest,
  formatConnector,
  formatConnectorDoctor,
  formatConnectors,
  formatEntityList,
  formatFailure,
  formatIngest,
  formatItem,
  formatMap,
  formatReindex,
  formatSearch,
  formatStatus,
  reindexFailures,
  isRecord as isAgentKnowledgeRecord,
  type AgentKnowledgeFailureLike,
} from './knowledge-format.js';
export {
  AGENT_KNOWLEDGE_BATCH_DEADLINE_MS,
  AGENT_KNOWLEDGE_READ_DEADLINE_MS,
  AGENT_KNOWLEDGE_WRITE_DEADLINE_MS,
  classifyKnowledgeError,
  createAgentPlatform,
  fetchConnectedHostStatus,
  findAgentKnowledgeScopeContamination,
  findDisallowedKnowledgeScopeFlag,
  formatScopeFlagRejection,
  getAgentKnowledgeJson,
  normalizeAgentKnowledgeData,
  postAgentKnowledgeJson,
  postAgentKnowledgeUpload,
  resolveConnectedHostConnection,
  runKnowledgeCall,
  type AgentKnowledgeConnection,
  type AgentKnowledgeConnectionRuntime,
  type AgentKnowledgeFailure,
  type AgentKnowledgeRequestOptions,
  type AgentKnowledgeResult,
  type AgentKnowledgeSuccess,
  type AgentKnowledgeUploadFile,
} from './knowledge-runtime.js';
export * from './knowledge-tool.js';
export {
  SOURCE_KINDS as AGENT_KNOWLEDGE_INGEST_SOURCE_KINDS,
  createAgentKnowledgeIngestInputProjector,
  createAgentKnowledgeIngestTool,
  registerAgentKnowledgeIngestTool,
  type AgentKnowledgeIngestSourceKind,
  type AgentKnowledgeIngestToolArgs,
} from './knowledge-ingest-tool.js';
export * from './connected-host-dial.js';
export * from './connected-host-pairing-store.js';
export * from './connected-host-auth.js';
export * from './connected-host-client.js';
export * from './operator-connection-owner.js';
export * from './daemon-operator-client.js';
export * from './agent-delegation-credential.js';
export * from './agent-call-credential.js';
export * from './in-process-host.js';
export * from './service-lifecycle.js';
export * from './operator-actions.js';
export * from './operator-automation-target.js';
export * from './operator-request-policy.js';
export * from './operator-method-receipt.js';
export * from './operator-input-projector.js';
export * from './operator-action-tool.js';
export * from './operator-briefing-tool.js';
export * from './operator-method-tool.js';
export * from './connected-host-verb-error.js';
export * from './accounts-admission.js';
export * from './accounts-tool.js';
export * from './schedule-next-routes.js';
export * from './personal-ops-effect-receipt.js';
export * from './autonomy-schedule.js';
export * from './reminder-schedule.js';
export * from './schedule-edit.js';
export * from './channel-delivery-receipts.js';
export * from './channel-send-tool.js';
export * from './browser-tool.js';
export * from './outward-approvals.js';
export * from './session-expectations.js';
export * from './google-admission.js';
export * from './google-tool.js';
export * from './google-wiring.js';
export * from './schedule-effect.js';
export * from './schedule-tool.js';
export * from './autonomy-schedule-tool.js';
export * from './schedule-edit-tool.js';
export * from './reminder-schedule-tool.js';
