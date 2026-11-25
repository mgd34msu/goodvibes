import { isDeepStrictEqual } from 'node:util';
import { captureStrictJudgmentJson } from '@goodvibes/engine/platform/platform/gate';
import { randomUUID } from 'node:crypto';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { ChatRequest, ChatResponse, LLMProvider } from '@goodvibes/engine/platform/platform/providers';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolInputProjector, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { registerComparisonCandidate, runAdmittedComparisonCandidate } from './model-compare-candidate.js';
import { COMPARISON_TEXT_LIMIT, comparisonSharedText, screenComparisonRequest } from './model-compare-candidate-input.js';
import { createComparisonOperation } from './model-compare-operation.js';
import { createZipArchive } from './artifact-archive.js';
import type { AgentModelCompareToolArgs, AgentModelCompareToolDeps, CompareCandidateResult, LoadedComparisonJudgment, SavedComparisonArtifact, StoredComparison } from './model-compare-types.js';
import { BLIND_LABELS, DEFAULT_CANDIDATE_COUNT, DEFAULT_MAX_TOKENS, DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES, MAX_SIDE_BY_SIDE_PREVIEW_BYTES, MIN_CANDIDATES, MODE_ANALYTICS, MODE_APPLY, MODE_EXPORT, MODE_HANDOFF, MODE_HANDOFF_ARCHIVE, MODE_HANDOFF_DIFF, MODE_JUDGE, MODE_REVEAL, MODE_REVIEW, MODE_ROUTE_DECISION, MODE_RUN, MODE_SIDE_BY_SIDE, MODE_SYNTHESIS } from './model-compare-types.js';
import { benchmarkRouteConstraint, buildRunPromptFromArtifact, isLocalCompareModel, formatPreview, formatReveal, formatReview, formatRunResult, formatSavedComparisonArtifacts, formatSavedHandoffArtifacts, loadComparisonFromArtifact, parseMode, rememberComparison, resolveComparisonForRead, resolveCurrentModel, runCandidate, saveComparisonArtifact, selectComparisonModels } from './model-compare-run.js';
import { ensureSelectableWinnerModel, findCandidate, formatApplyPreview, formatApplyResult, formatComparisonAnalytics, formatComparisonSynthesis, formatJudgePreview, formatJudgmentResult, formatRouteDecisionPreview, formatRouteDecisionResult, loadJudgmentFromArtifact, loadSavedJudgments, parseRouteDecision, unreadableJudgmentsNote, readComparisonAnalyticsFilters, saveComparisonJudgmentArtifact, saveRouteDecisionArtifact, unjudgeableWinnerReason } from './model-compare-judgment.js';
import { comparisonExportMarkdown, comparisonHandoffMarkdown, formatSideBySideReview, judgmentExportMarkdown, loadHandoffRelatedArtifacts, saveComparisonExportArtifact, saveComparisonHandoffArtifact } from './model-compare-export.js';
import { buildComparisonHandoffArchivePayload, findRouteDecisionArtifactIdsForHandoff, formatExportPreview, formatExportResult, formatHandoffArchivePreview, formatHandoffArchiveResult, formatHandoffDiff, formatHandoffPreview, formatHandoffResult, loadHandoffArchiveArtifacts, loadHandoffDiffArtifact, loadHandoffFromArtifact, saveComparisonHandoffArchiveArtifact } from './model-compare-handoff.js';
import { clamp, failure, output, previewText, readBenchmarkKind, readComparisonTag, readModelRefs, readNumber, readString, readStringList } from './model-compare-utils.js';
import { readFlag } from './tool-args.js';
import { confirmParameter, requestParameter } from './effect-admission.js';
import { toolErrorText } from './tool-error-text.js';
export type { AgentModelCompareCatalogModel, AgentModelCompareModelCatalog, AgentModelCompareProviderRegistry, AgentModelCompareRouteUpdateResult, AgentModelCompareToolArgs, AgentModelCompareToolDeps } from './model-compare-types.js';

/**
 * The judgment with its winner model read from the comparison it names. The
 * comparison artifact holds every candidate's model, so a blind judgment is
 * enough to apply: nobody has to judge twice. The judgment file is plain data,
 * so a winner model it states itself must match the comparison. When the
 * comparison was not saved, a revealed judgment still carries its own winner
 * model; `checked` is false so the result says it was not checked.
 */
async function resolveJudgmentWinner(
  judgment: LoadedComparisonJudgment,
  artifactStore: AgentModelCompareToolDeps['artifactStore'],
  comparisons: Map<string, StoredComparison>,
): Promise<{ readonly judgment: LoadedComparisonJudgment; readonly checked: boolean } | string> {
  const source = await resolveComparisonForRead({ artifactStore, comparisons, comparisonId: judgment.comparisonId, artifactId: judgment.sourceArtifactId ?? '' });
  if (!source) return { judgment, checked: false };
  const winner = findCandidate(source, judgment.winnerBlindId);
  if (!winner) return `Nothing was changed: the judgment names Candidate ${judgment.winnerBlindId}, which comparison ${judgment.comparisonId} does not have. Judge that comparison again and use the new judgment.`;
  const unjudgeable = unjudgeableWinnerReason(source, winner);
  if (unjudgeable) return `Nothing was changed: ${unjudgeable} Judge comparison ${judgment.comparisonId} again and use the new judgment.`;
  if (judgment.winnerModel?.registryKey && judgment.winnerModel.registryKey !== winner.model.registryKey) {
    return `Nothing was changed: the judgment names winner model ${judgment.winnerModel.registryKey}, but Candidate ${judgment.winnerBlindId} of comparison ${judgment.comparisonId} is ${winner.model.registryKey}. Judge that comparison again and use the new judgment.`;
  }
  const { registryKey, providerId, modelId, displayName } = winner.model;
  return { judgment: { ...judgment, winnerModel: { registryKey, providerId, modelId, displayName } }, checked: true };
}

export function createAgentModelCompareTool(sourceDeps: AgentModelCompareToolDeps): Tool {
  const comparisons = new Map<string, StoredComparison>();
  if (sourceDeps.toolRegistry) registerComparisonCandidate(sourceDeps.toolRegistry, sourceDeps);
  return {
    definition: {
      name: 'agent_model_compare',
      activity: { doing: 'Comparing', did: 'compared', object: 'models' },
      description: 'Blind-compare models on a prompt or artifact (run, reveal, review, sideBySide), save a judgment (judge), then apply the winner route or record a route decision (apply, routeDecision), and export, hand off, archive or diff reviews (export, handoff, handoffArchive, handoffDiff) or summarize saved judgments (analytics, synthesis).',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [MODE_RUN, MODE_REVEAL, MODE_REVIEW, MODE_SIDE_BY_SIDE, MODE_JUDGE, MODE_APPLY, MODE_ROUTE_DECISION, MODE_EXPORT, MODE_HANDOFF, MODE_HANDOFF_ARCHIVE, MODE_HANDOFF_DIFF, MODE_ANALYTICS, MODE_SYNTHESIS],
            description: 'Select compare workflow mode.',
          },
          prompt: {
            type: 'string',
            description: 'Exact prompt sent identically to every candidate model.',
          },
          modelRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional registry keys or model ids. Omit to auto-select candidates.',
          },
          candidateCount: {
            type: 'number',
            description: 'Number of candidates to auto-select when modelRefs is omitted. 2 to 4; default 2.',
          },
          rubric: {
            type: 'string',
            description: 'Optional judging rubric shown with the blinded results.',
          },
          systemPrompt: {
            type: 'string',
            description: 'Optional system prompt sent identically to every candidate model.',
          },
          maxTokens: {
            type: 'number',
            description: 'Optional per-candidate output cap. Omit or use 0 for the selected model’s supported output limit.',
          },
          reveal: {
            type: 'boolean',
            description: 'For run, review, side-by-side, export and handoff: include model identities (and a judged winner model) in this output; without it none is printed, even when the judgment stored one. For judge: also write the winner model into the judgment. apply and routeDecision read the winner model from the judged comparison either way, so a blind judgment can be applied; a judgment of a comparison that was not saved needs reveal:true to be applied.',
          },
          saveArtifact: {
            type: 'boolean',
            description: 'Defaults true; save the local JSON review artifact.',
          },
          benchmarkKind: {
            type: 'string',
            description: 'Optional benchmark tag for saved comparisons or analytics filters. A tag beginning with "local" (local-model-route) makes a blank modelRefs list fill from local routes only, and refuses with fewer than two; name a remote baseline in modelRefs to include one.',
          },
          taskType: {
            type: 'string',
            description: 'Optional task type tag for saved comparisons or analytics filters.',
          },
          documentId: {
            type: 'string',
            description: 'Optional document id tag for saved comparisons or analytics filters.',
          },
          comparisonId: {
            type: 'string',
            description: 'Stored comparison id for reveal, review and judge (or pass a saved comparison artifactId).',
          },
          artifactId: {
            type: 'string',
            description: `Run source artifact (a text artifact inlined into the prompt; the prompt, document and request together may hold at most ${COMPARISON_TEXT_LIMIT.toLocaleString('en-US')} characters), or the saved comparison or judgment artifact id for apply, routeDecision, export, handoff, handoffArchive, sideBySide and review.`,
          },
          leftArtifactId: {
            type: 'string',
            description: 'Left saved reviewer handoff artifact id for handoffDiff.',
          },
          rightArtifactId: {
            type: 'string',
            description: 'Right saved reviewer handoff artifact id for handoffDiff.',
          },
          sectionId: {
            type: 'string',
            description: 'Optional handoffDiff jump: all, metadata, policy, related, comparison.',
          },
          winnerBlindId: {
            type: 'string',
            description: 'Candidate label to save as winner, such as A or Candidate B.',
          },
          winner: {
            type: 'string',
            description: 'Alias for winnerBlindId.',
          },
          reasons: {
            type: 'string',
            description: 'User-visible reasons for the saved judgment.',
          },
          notes: {
            type: 'string',
            description: 'Optional extra judgment notes.',
          },
          decision: {
            type: 'string',
            enum: ['left-unchanged', 'leave-unchanged', 'keep-current', 'no-change'],
            description: 'routeDecision receipt choice; defaults to left-unchanged. To apply the winner use mode:"apply".',
          },
          limit: {
            type: 'number',
            description: 'Max saved judgments for analytics and synthesis. 1 to 100; default 20.',
          },
          includeReasons: {
            type: 'boolean',
            description: 'If true, include short reason excerpts.',
          },
          relatedArtifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related artifact ids for sideBySide (optional) and handoff (required, at least one).',
          },
          previewBytes: {
            type: 'number',
            description: 'Max bytes per related artifact preview.',
          },
          confirm: confirmParameter(),
          preview: { type: 'boolean', description: 'For mode:run, inspect a comparison request without metered provider calls or result writes.' },
          explicitUserRequest: requestParameter('kept with route-decision receipts'),
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, options) => {
      try {
        const operation = createComparisonOperation(sourceDeps, rawArgs, options);
        const deps = operation.deps;
        operation.assertCurrent();
        const args = rawArgs as AgentModelCompareToolArgs;
        const mode = parseMode(args.mode);
        if (args.preview === true && mode !== MODE_RUN) return failure('preview:true is available for mode:run.');
        if (mode === MODE_REVEAL || mode === MODE_REVIEW) {
          const comparisonId = readString(args.comparisonId);
          const artifactId = readString(args.artifactId);
          if (mode === MODE_REVIEW && !comparisonId && !artifactId) {
            return output(formatSavedComparisonArtifacts(deps.artifactStore));
          }
          if (!comparisonId && !artifactId) {
            return failure(`${mode} mode requires comparisonId or artifactId.`);
          }
          const comparison = await resolveComparisonForRead({
            artifactStore: deps.artifactStore,
            comparisons,
            comparisonId,
            artifactId,
          });
          if (!comparison) {
            return failure(`Unknown comparison. Run a new comparison or pass a saved comparison artifactId.`);
          }
          rememberComparison(comparisons, comparison);
          return output(mode === MODE_REVEAL ? formatReveal(comparison) : formatReview(comparison, readFlag(args.reveal, 'reveal', false)));
        }

        if (mode === MODE_SIDE_BY_SIDE) {
          const artifactId = readString(args.artifactId);
          if (!artifactId) {
            return output([
              formatSavedComparisonArtifacts(deps.artifactStore),
              '',
              'Choose a saved comparison or judgment artifactId to render a side-by-side reviewer view.',
            ].join('\n'));
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Side-by-side reviewer view is unavailable because this runtime cannot read artifact content.');
          }
          const relatedArtifactIds = readStringList(args.relatedArtifactIds).filter((relatedId) => relatedId !== artifactId);
          const previewBytes = clamp(
            readNumber(args.previewBytes, DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES),
            200,
            MAX_SIDE_BY_SIDE_PREVIEW_BYTES,
          );
          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const reveal = readFlag(args.reveal, 'reveal', false);
            const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, reveal, previewBytes);
            rememberComparison(comparisons, comparison);
            return output(formatSideBySideReview({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              comparison,
              reveal,
              relatedArtifacts,
              previewBytes,
            }));
          }
          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          const judgmentReveal = readFlag(args.reveal, 'reveal', false) && judgment.revealIncludedInJudgment;
          const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, judgmentReveal, previewBytes);
          return output(formatSideBySideReview({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            judgment,
            reveal: judgmentReveal,
            relatedArtifacts,
            previewBytes,
          }));
        }

        if (mode === MODE_HANDOFF_DIFF) {
          const leftArtifactId = readString(args.leftArtifactId || args.artifactId);
          const rightArtifactId = readString(args.rightArtifactId);
          if (!leftArtifactId && !rightArtifactId) {
            return output([
              formatSavedHandoffArtifacts(deps.artifactStore),
              '',
              'Choose two saved reviewer handoff artifact ids with leftArtifactId and rightArtifactId to render a visual diff.',
            ].join('\n'));
          }
          if (!leftArtifactId || !rightArtifactId) {
            return failure('handoffDiff mode requires leftArtifactId and rightArtifactId.');
          }
          if (leftArtifactId === rightArtifactId) {
            return failure('handoffDiff mode requires two different reviewer handoff artifact ids.');
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Reviewer handoff diff is unavailable because this runtime cannot read artifact content.');
          }
          const left = await loadHandoffDiffArtifact(deps.artifactStore, leftArtifactId);
          const right = await loadHandoffDiffArtifact(deps.artifactStore, rightArtifactId);
          if (!left || !right) {
            return failure('Unknown reviewer handoff artifact. Pass two saved blind model comparison handoff artifact ids.');
          }
          return output(formatHandoffDiff({ left, right, sectionId: readString(args.sectionId) }));
        }

        if (mode === MODE_ANALYTICS) {
          const limit = clamp(readNumber(args.limit, 20), 1, 100);
          const filters = readComparisonAnalyticsFilters(args);
          const { judgments, unreadable } = await loadSavedJudgments(deps.artifactStore, limit, filters);
          return output(`${formatComparisonAnalytics({
            judgments,
            limit,
            includeReasons: readFlag(args.includeReasons, 'includeReasons', true),
            filters,
            storeAvailable: Boolean(deps.artifactStore?.list && deps.artifactStore.readContent),
          })}${unreadableJudgmentsNote(unreadable)}`);
        }

        if (mode === MODE_SYNTHESIS) {
          const limit = clamp(readNumber(args.limit, 20), 1, 100);
          const filters = readComparisonAnalyticsFilters(args);
          const { judgments, unreadable } = await loadSavedJudgments(deps.artifactStore, limit, filters);
          return output(`${await formatComparisonSynthesis({
            artifactStore: deps.artifactStore, request: rawArgs, readingOptions: { signal: options?.signal, assertCurrent: operation.assertCurrent, sourceOwner: operation.sourceOwner },
            judgments,
            limit,
            includeReasons: readFlag(args.includeReasons, 'includeReasons', true),
            filters,
            storeAvailable: Boolean(deps.artifactStore?.list && deps.artifactStore.readContent),
          })}${unreadableJudgmentsNote(unreadable)}`);
        }

        if (mode === MODE_JUDGE) {
          const comparisonId = readString(args.comparisonId);
          const artifactId = readString(args.artifactId);
          const winnerBlindId = readString(args.winnerBlindId ?? args.winner);
          const reasons = readString(args.reasons);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!comparisonId && !artifactId) return failure('judge mode requires comparisonId or artifactId.');
          if (!winnerBlindId) return failure('winnerBlindId is required for judge mode.');
          if (!reasons) return failure('reasons are required for judge mode.');
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatJudgePreview(args),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const comparison = await resolveComparisonForRead({
            artifactStore: deps.artifactStore,
            comparisons,
            comparisonId,
            artifactId,
          });
          if (!comparison) return failure('Unknown comparison. Run a new comparison or pass a saved comparison artifactId.');
          const winner = findCandidate(comparison, winnerBlindId);
          if (!winner) {
            return failure(`Unknown winnerBlindId ${winnerBlindId}. Available candidates: ${comparison.candidates.map((candidate) => candidate.blindId).join(', ')}.`);
          }
          const unjudgeable = unjudgeableWinnerReason(comparison, winner);
          if (unjudgeable) return failure(`Nothing was saved: ${unjudgeable}`);
          const artifact = await saveComparisonJudgmentArtifact({
            artifactStore: deps.artifactStore,
            comparison,
            winner,
            reasons,
            notes: readString(args.notes),
            reveal: readFlag(args.reveal, 'reveal', false),
          });
          rememberComparison(comparisons, comparison);
          return output(formatJudgmentResult({
            comparison,
            winner,
            artifact,
            reasons,
            reveal: readFlag(args.reveal, 'reveal', false),
          }));
        }

        if (mode === MODE_APPLY) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return failure('apply mode requires a saved judgment artifactId.');
          if (!deps.applyModelRoute) {
            return failure('Model route updates are unavailable in this runtime, so no route was changed. Ask the user to change the model themselves.');
          }
          if (!deps.artifactStore?.readContent) {
            return failure('Saved judgment artifacts are unavailable because this runtime cannot read artifact content.');
          }
          const loaded = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!loaded) return failure('Unknown judgment artifact. Pass a saved model comparison judgment artifactId.');
          const resolved = await resolveJudgmentWinner(loaded, deps.artifactStore, comparisons);
          if (typeof resolved === 'string') return failure(resolved);
          const { judgment, checked } = resolved;
          if (!judgment.winnerModel) {
            return failure(`Nothing was changed: comparison ${judgment.comparisonId} is not available (it was not saved, or it expired) and this blind judgment does not name its winner model. Run the comparison again with saveArtifact:true, judge it, then apply that judgment.`);
          }
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatApplyPreview(judgment),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          await ensureSelectableWinnerModel(deps.modelCatalog, judgment.winnerModel.registryKey);
          // Changing the default model changes the settings this call was admitted under, and from that moment the
          // gate holds every further write of the call as stale. So the record of the decision and the model's use
          // are written first, and the change of model is the call's last act.
          const winnerKey = judgment.winnerModel.registryKey;
          const before = (await resolveCurrentModel(deps.modelCatalog))?.registryKey ?? '';
          const planned = { ...(before ? { previousModel: before } : {}), selectedModel: winnerKey };
          let receipt: SavedComparisonArtifact | null = null;
          let receiptError: string | null = null;
          try {
            receipt = await saveRouteDecisionArtifact({
              artifactStore: deps.artifactStore,
              decision: 'applied-winner',
              judgment,
              route: planned,
              explicitUserRequest,
            });
          } catch (error) {
            receiptError = error instanceof Error ? error.message : String(error);
          }
          let usageError: string | null = null;
          try { await deps.modelCatalog.recordModelUsage?.(winnerKey); }
          catch (error) { usageError = error instanceof Error ? error.message : String(error); }
          let result: Awaited<ReturnType<NonNullable<typeof deps.applyModelRoute>>>;
          try {
            result = await deps.applyModelRoute(winnerKey);
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            return failure(`The default model was not changed: ${why}${receipt ? ` The decision record ${receipt.artifactId}, saved just before, names ${winnerKey} as applied; it was not.` : ''}`);
          }
          return output(formatApplyResult({ judgment, result, receipt, receiptError, usageError, winnerUnchecked: !checked }));
        }

        if (mode === MODE_ROUTE_DECISION) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          const decision = args.decision === undefined || readString(args.decision) === '' ? 'left-unchanged' : parseRouteDecision(args.decision);
          if (!artifactId) return failure('routeDecision mode requires a saved judgment artifactId.');
          if (decision !== 'left-unchanged') {
            return failure('routeDecision mode records leave-unchanged decisions: pass decision:"left-unchanged" or omit it. To apply a revealed winner use mode:"apply".');
          }
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Route-decision receipts are unavailable because this runtime cannot read and create artifact content.');
          }
          const loaded = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!loaded) return failure('Unknown judgment artifact. Pass a saved model comparison judgment artifactId.');
          const resolved = await resolveJudgmentWinner(loaded, deps.artifactStore, comparisons);
          if (typeof resolved === 'string') return failure(resolved);
          const { judgment } = resolved;
          const currentModel = (await resolveCurrentModel(deps.modelCatalog))?.registryKey ?? null;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatRouteDecisionPreview({ judgment, decision, currentModel }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const receipt = await saveRouteDecisionArtifact({
            artifactStore: deps.artifactStore,
            decision,
            judgment,
            currentModel,
            explicitUserRequest,
          });
          return output(formatRouteDecisionResult({ judgment, decision, receipt, currentModel }));
        }

        if (mode === MODE_EXPORT) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return failure('export mode requires a saved comparison or judgment artifactId.');
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Saved comparison export is unavailable because this runtime cannot read and create artifact content.');
          }

          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const reveal = readFlag(args.reveal, 'reveal', false);
            if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
              return failure([
                formatExportPreview({
                  sourceKind: 'comparison',
                  sourceArtifactId: artifactId,
                  comparisonId: comparison.comparisonId,
                  reveal,
                }),
                '',
                'This operation requires current recorded effect admission.',
              ].join('\n'));
            }
            const artifact = await saveComparisonExportArtifact({
              artifactStore: deps.artifactStore,
              sourceArtifactId: artifactId,
              sourceKind: 'comparison',
              comparisonId: comparison.comparisonId,
              markdown: comparisonExportMarkdown(comparison, reveal),
              reveal,
            });
            rememberComparison(comparisons, comparison);
            return output(formatExportResult({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              artifact,
            }));
          }

          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          // This output reveals the winner model only when the request asks and the judgment stored one.
          const reveal = readFlag(args.reveal, 'reveal', false) && judgment.revealIncludedInJudgment;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatExportPreview({
                sourceKind: 'judgment',
                sourceArtifactId: artifactId,
                comparisonId: judgment.comparisonId,
                reveal,
              }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const artifact = await saveComparisonExportArtifact({
            artifactStore: deps.artifactStore,
            sourceArtifactId: artifactId,
            sourceKind: 'judgment',
            comparisonId: judgment.comparisonId,
            markdown: judgmentExportMarkdown(judgment, reveal),
            reveal,
          });
          return output(formatExportResult({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            artifact,
          }));
        }

        if (mode === MODE_HANDOFF) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          const relatedArtifactIds = readStringList(args.relatedArtifactIds).filter((relatedId) => relatedId !== artifactId);
          if (!artifactId) return failure('handoff mode requires a saved comparison or judgment artifactId.');
          if (relatedArtifactIds.length === 0) return failure('handoff mode requires at least one relatedArtifactIds entry.');
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Reviewer handoff is unavailable because this runtime cannot read and create artifact content.');
          }

          const comparison = await loadComparisonFromArtifact(deps.artifactStore, artifactId);
          if (comparison) {
            const reveal = readFlag(args.reveal, 'reveal', false);
            if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
              return failure([
                formatHandoffPreview({
                  sourceKind: 'comparison',
                  sourceArtifactId: artifactId,
                  comparisonId: comparison.comparisonId,
                  reveal,
                  relatedArtifactIds,
                }),
                '',
                'This operation requires current recorded effect admission.',
              ].join('\n'));
            }
            const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, reveal);
            const artifact = await saveComparisonHandoffArtifact({
              artifactStore: deps.artifactStore,
              sourceArtifactId: artifactId,
              sourceKind: 'comparison',
              comparisonId: comparison.comparisonId,
              relatedArtifactIds,
              markdown: comparisonHandoffMarkdown({
                sourceKind: 'comparison',
                sourceArtifactId: artifactId,
                comparisonId: comparison.comparisonId,
                comparisonMarkdown: comparisonExportMarkdown(comparison, reveal),
                reveal,
                relatedArtifacts,
              }),
              reveal,
            });
            rememberComparison(comparisons, comparison);
            return output(formatHandoffResult({
              sourceKind: 'comparison',
              sourceArtifactId: artifactId,
              comparisonId: comparison.comparisonId,
              relatedArtifactCount: relatedArtifacts.length,
              artifact,
            }));
          }

          const judgment = await loadJudgmentFromArtifact(deps.artifactStore, artifactId);
          if (!judgment) return failure('Unknown comparison or judgment artifact. Pass a saved blind model comparison artifactId.');
          // This output reveals the winner model only when the request asks and the judgment stored one.
          const reveal = readFlag(args.reveal, 'reveal', false) && judgment.revealIncludedInJudgment;
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatHandoffPreview({
                sourceKind: 'judgment',
                sourceArtifactId: artifactId,
                comparisonId: judgment.comparisonId,
                reveal,
                relatedArtifactIds,
              }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }
          const relatedArtifacts = await loadHandoffRelatedArtifacts(deps.artifactStore, relatedArtifactIds, reveal);
          const artifact = await saveComparisonHandoffArtifact({
            artifactStore: deps.artifactStore,
            sourceArtifactId: artifactId,
            sourceKind: 'judgment',
            comparisonId: judgment.comparisonId,
            relatedArtifactIds,
            markdown: comparisonHandoffMarkdown({
              sourceKind: 'judgment',
              sourceArtifactId: artifactId,
              comparisonId: judgment.comparisonId,
              comparisonMarkdown: judgmentExportMarkdown(judgment, reveal),
              reveal,
              relatedArtifacts,
            }),
            reveal,
          });
          return output(formatHandoffResult({
            sourceKind: 'judgment',
            sourceArtifactId: artifactId,
            comparisonId: judgment.comparisonId,
            relatedArtifactCount: relatedArtifacts.length,
            artifact,
          }));
        }

        if (mode === MODE_HANDOFF_ARCHIVE) {
          const artifactId = readString(args.artifactId);
          const explicitUserRequest = readString(args.explicitUserRequest);
          if (!artifactId) return output(formatSavedHandoffArtifacts(deps.artifactStore));
          if (!deps.artifactStore?.readContent || !deps.artifactStore.create) {
            return failure('Reviewer handoff archive is unavailable because this runtime cannot read and create artifact content.');
          }

          const handoff = await loadHandoffFromArtifact(deps.artifactStore, artifactId);
          if (!handoff) return failure('Unknown reviewer handoff artifact. Pass a saved blind model comparison handoff artifactId.');
          const routeDecisionArtifactIds = findRouteDecisionArtifactIdsForHandoff(deps.artifactStore, handoff);
          if (!assertCurrentToolEffect(rawArgs, options, 'write')) {
            return failure([
              formatHandoffArchivePreview({ handoff, routeDecisionArtifactIds }),
              '',
              'This operation requires current recorded effect admission.',
            ].join('\n'));
          }

          const artifacts = await loadHandoffArchiveArtifacts(deps.artifactStore, handoff, routeDecisionArtifactIds);
          const payload = await buildComparisonHandoffArchivePayload({ handoff, artifacts }, {
            signal: options?.signal, assertCurrent: operation.assertWrite,
          });
          operation.assertWrite();
          const archive = await createZipArchive(payload.entries);
          const artifact = await saveComparisonHandoffArchiveArtifact({
            artifactStore: deps.artifactStore,
            handoff,
            payload,
            archive,
          });
          return output(formatHandoffArchiveResult({
            handoff,
            artifact,
            artifactCount: payload.artifactCount,
            routeDecisionArtifactCount: payload.routeDecisionArtifactIds.length,
            sourceBytes: payload.sourceBytes,
            archiveBytes: archive.byteLength,
          }));
        }

        const promptInput = readString(args.prompt);
        const explicitUserRequest = readString(args.explicitUserRequest);
        const sourceArtifactId = readString(args.artifactId);
        const refs = readModelRefs(args.modelRefs);
        const benchmarkKind = readBenchmarkKind(args.benchmarkKind);
        const taskType = readComparisonTag(args.taskType);
        const requestedDocumentId = readComparisonTag(args.documentId);
        const candidateCount = clamp(Math.trunc(readNumber(args.candidateCount, DEFAULT_CANDIDATE_COUNT)), MIN_CANDIDATES, BLIND_LABELS.length);
        if (!promptInput && !sourceArtifactId) return failure('prompt or artifactId is required.');
        if (args.preview === true) return output(formatPreview(args, refs, candidateCount));
        if (!assertCurrentToolEffect(rawArgs, options, 'send')) {
          return failure([
            formatPreview(args, refs, candidateCount),
            '',
            'This operation requires current recorded effect admission.',
          ].join('\n'));
        }
        const runPrompt = await buildRunPromptFromArtifact({
          artifactStore: deps.artifactStore,
          prompt: promptInput,
          artifactId: sourceArtifactId,
        });
        const prompt = runPrompt.prompt;

        const maxTokens = Math.max(0, Math.trunc(readNumber(args.maxTokens, DEFAULT_MAX_TOKENS)));
        const systemPrompt = readString(args.systemPrompt);
        const models = await selectComparisonModels(deps.modelCatalog, refs, candidateCount, sourceDeps.random,
          { constraint: benchmarkRouteConstraint(benchmarkKind), isLocal: (model) => isLocalCompareModel(deps.providerRegistry, model) });
        if (models.length > BLIND_LABELS.length) return failure(`Compare at most ${BLIND_LABELS.length} models at a time; ${models.length} were requested.`);
        operation.assertSend();
        // Every candidate sends the same text, so it is screened once here and each candidate is cleared against that screening.
        const screening = await screenComparisonRequest(operation.sourceOwner, comparisonSharedText(prompt, systemPrompt, rawArgs), options?.signal);
        let settled: PromiseSettledResult<CompareCandidateResult>[];
        try {
          operation.assertSend();
          settled = await Promise.allSettled(models.map((model, index) => runAdmittedComparisonCandidate(sourceDeps.toolRegistry, options,
            model, BLIND_LABELS[index] ?? String(index + 1), prompt, systemPrompt, maxTokens, operation.assertCurrent, rawArgs, screening.id,
            sourceDeps.dispatchCandidate)));
        } finally { await screening.release().catch(() => {}); }
        operation.assertCurrent();
        // A candidate that was refused or dropped is recorded as failed so the
        // outputs of the others, which were already sent and billed, are kept.
        const results = settled.map((result, index): CompareCandidateResult => {
          if (result.status === 'fulfilled') return result.value;
          if (result.reason instanceof ToolInputProjectionError || options?.signal?.aborted) throw result.reason;
          return { blindId: BLIND_LABELS[index] ?? String(index + 1), model: models[index]!, status: 'failed', content: '', latencyMs: 0,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
        });
        const reveal = readFlag(args.reveal, 'reveal', false);
        const baseComparison: StoredComparison = {
          comparisonId: `cmp_${randomUUID()}`,
          createdAt: new Date().toISOString(),
          promptPreview: previewText(prompt, 160),
          rubric: readString(args.rubric),
          ...(runPrompt.sourceArtifact ? { sourceArtifact: runPrompt.sourceArtifact } : {}),
          ...(benchmarkKind ? { benchmarkKind } : {}),
          ...(taskType ? { taskType } : {}),
          ...(requestedDocumentId || runPrompt.sourceArtifact?.documentId ? { documentId: requestedDocumentId || runPrompt.sourceArtifact?.documentId } : {}),
          candidates: results,
        };
        const saved = await saveComparisonArtifact({
          artifactStore: deps.artifactStore,
          comparison: baseComparison,
          prompt,
          systemPrompt,
          maxTokens,
          revealIncludedInTranscript: reveal,
          enabled: readFlag(args.saveArtifact, 'saveArtifact', true),
          ...(benchmarkKind ? { benchmarkKind } : {}),
        });
        const comparison: StoredComparison = {
          ...baseComparison,
          ...(saved.artifact ? { artifact: saved.artifact } : {}),
          artifactStatus: saved.status,
        };
        operation.assertWrite();
        rememberComparison(comparisons, comparison);
        await Promise.allSettled(models.map((model) => deps.modelCatalog.recordModelUsage?.(model.registryKey)));
        operation.assertCurrent();
        const rendered = formatRunResult(comparison, reveal);
        return results.some((candidate) => candidate.status === 'completed')
          ? output(rendered)
          : failure(rendered);
      } catch (error) {
        return failure(toolErrorText(error));
      }
    },
  };
}

/** A run preview renders the request without a provider send or persisted mutation. */
export function createModelCompareInputProjector(): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent();
    const original = captureStrictJudgmentJson(request.args);
    return { status: 'projected', args: request.args,
      ...(parseMode(request.args.mode) === MODE_RUN && request.args.preview === true ? { resultPublication: 'read-only' as const } : {}),
      assertRepairedArgs(args) {
        if (!isDeepStrictEqual(captureStrictJudgmentJson(args), original)) throw new ToolInputProjectionError('binding-changed');
        request.assertCurrent();
      },
    };
  } };
}

export function registerAgentModelCompareTool(
  registry: ToolRegistry,
  deps: AgentModelCompareToolDeps,
): void {
  registry.register(createAgentModelCompareTool({ ...deps, toolRegistry: registry }), { inputProjection: createModelCompareInputProjector() });
}
