import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { clearSetupCheckpoint, markSetupCheckpoint, setupCheckpointSummary } from './agent-harness-setup-posture.ts';
import { runLocalWorkspaceAction } from './agent-harness-local-operations.ts';
import { AGENT_WORKSPACE_CATEGORIES, buildWorkspaceEditorContext, createWorkspaceEditor, describeWorkspaceAction, describeWorkspaceCategory, listWorkspaceActions, resolveWorkspaceActionDetail } from './agent-harness-workspace-actions.ts';
import { runTranslatedWorkspaceCommand } from './agent-harness-command-runner.ts';
import { runWorkspaceEditorAction } from './agent-harness-workspace-editor-runner.ts';
import { effectOutput, error, output, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { formatHarnessError } from '../agent/harness-control.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { executeAdmittedAgentSettingsImport, isAgentSettingsImportMutation } from './agent-settings-import-admission.ts';
import { agentResearchSourceOwner } from '@goodvibes-jev/engine/terminal-shell/agent-turn/protected-research-report';
import { assertModelReadingInputCurrent, captureModelReadingInput, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturedHarnessSettingsImportPreview, harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { getOnboardingCheckMarkerPath, getOnboardingCompletionMarkerPath, writeOnboardingCheckMarker, writeOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';

/** Editors that read the runtime snapshot (templates, selected routine, handoff artifacts, review defaults, OAuth status); the rest run the same on the empty fallback. */
const EDITOR_KINDS_USING_RUNTIME_CONTEXT: ReadonlySet<string> = new Set([
  'profile', 'routine-schedule', 'calendar-oauth-google', 'calendar-oauth-outlook',
  'document-export', 'document-review-packet-preset', 'document-review-packet-share',
  'model-compare-handoff-diff', 'model-compare-apply', 'model-compare-route-decision', 'model-compare-export',
]);

export async function runWorkspaceAction(
  deps: AgentHarnessToolDeps,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const assertExecution = harnessCatalogExecutionGuard(args, options);
  const sourceOwner = agentResearchSourceOwner(deps.toolRegistry);
  const sourceCurrent = () => {
    options?.signal?.throwIfAborted();
    if (agentResearchSourceOwner(deps.toolRegistry) !== sourceOwner) throw new Error('Workspace source owner changed.');
  };
  const retainCurrent = retainHarnessCatalogCurrent(args);
  retainCurrent(sourceCurrent, 'workspace:original-source-owner');
  const request = captureStatefulCatalogRequest(deps.commandContext, args, {
    signal: options?.signal, sourceOwner, retainCurrent,
    assertCurrent: () => { assertExecution(); sourceCurrent(); },
  });
  const effectCatalogOptions = request.options;
  const resolved = await resolveWorkspaceActionDetail(args, effectCatalogOptions);
  request.assertCurrent();
  if (resolved?.status === 'ambiguous') return error(`Ambiguous Agent workspace action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) return error('run_workspace_action requires a valid actionId, command, target, or query. Use mode:"workspace_actions" to inspect available actions.');
  const { category, action, lookup } = resolved;

  if (action.safety === 'blocked') {
    return error(`Workspace action ${action.id} is blocked in Agent: ${action.detail}`);
  }
  if (action.kind === 'guidance') {
    const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
    return output({
      status: 'guidance',
      action: describeWorkspaceAction(category, action, { includeEditor: true, editorContext, lookup }),
    });
  }
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const target = AGENT_WORKSPACE_CATEGORIES.find((entry) => entry.id === action.targetCategoryId);
    return output({
      status: 'workspace_target',
      action: describeWorkspaceAction(category, action, { lookup }),
      targetCategory: target ? describeWorkspaceCategory(target) : action.targetCategoryId,
      targetActions: target ? target.actions.map((entry) => describeWorkspaceAction(target, entry)).slice(0, 40) : [],
    });
  }
  if (action.kind === 'command' && action.command) {
    if (/<[^>\s]+(?:\s+[^>]*)?>/.test(action.command)) {
      return effectOutput({
        status: 'needs_concrete_command',
        done: false,
        action: describeWorkspaceAction(category, action, { lookup }),
        note: 'This workspace action is a command template. Provide concrete values with mode:"run_command" once the exact command is known.',
      });
    }
    return runTranslatedWorkspaceCommand(deps, args, action.command, options);
  }
  if (action.kind === 'settings-import') {
    if (!isAgentSettingsImportMutation('agent_harness', args)) {
      try {
        const signal = options?.signal;
        const original = JSON.stringify(captureModelReadingInput(args));
        const assertExecution = harnessCatalogExecutionGuard(args, options);
        signal?.throwIfAborted(); assertExecution();
        const sourceOwner = agentResearchSourceOwner(deps.toolRegistry);
        const capture = capturedHarnessSettingsImportPreview(args, options, deps.commandContext, deps.toolRegistry);
        const assertCurrent = () => {
          signal?.throwIfAborted(); assertExecution();
          assertModelReadingInputCurrent(args, original); capture.assertCurrent();
          if (agentResearchSourceOwner(deps.toolRegistry) !== sourceOwner) throw new Error('Settings import reader changed.');
        };
        assertCurrent();
        const retainCurrent = retainHarnessCatalogCurrent(args);
        retainCurrent(capture.assertCurrent, 'settings-import.preview-source');
        return await withModelReadingSource({ preview: capture.preview, sources: capture.sourceViews },
          { signal, sourceOwner, assertCurrent, retainCurrent }, async captured => {
            assertCurrent();
            return output({ status: 'confirmation_required', action: describeWorkspaceAction(category, action, { lookup }),
              preview: captured.preview, next: 'Use action:"import" with current recorded settings admission to apply this source.' });
          });
      } catch (err) {
        // A stale or held source is a typed, retry-able outcome and an abort is the caller's: neither is "unavailable".
        options?.signal?.throwIfAborted();
        if (err instanceof ToolInputProjectionError) throw err;
        return error(`Settings import preview is unavailable or its captured source is no longer current: ${formatHarnessError(err)}`);
      }
    }
    try { return await executeAdmittedAgentSettingsImport(deps.commandContext, args, options); }
    catch (err) {
      options?.signal?.throwIfAborted();
      // Admission is refused with a typed held error before anything is written; anything else happened after the commit began.
      if (err instanceof ToolInputProjectionError) {
        if (err.problem === 'held') return error('Settings import requires a current recorded effect-owner admission. Nothing was written; ask the person to approve the import in the visible approval prompt, then call it again.');
        throw err;
      }
      return error(`Settings import failed after it started and may be partially applied: ${formatHarnessError(err)}. Inspect the settings before retrying; nothing was retried.`);
    }
  }
  if (action.kind === 'setup-checkpoint') {
    const operation = action.setupCheckpointOperation ?? 'show';
    if (operation === 'show') {
      const checkpoint = await setupCheckpointSummary(deps.commandContext, effectCatalogOptions);
      request.assertCurrent();
      return output({
        status: 'checkpoint_inspected',
        action: describeWorkspaceAction(category, action, { lookup }),
        checkpoint,
      });
    }
    const confirmationError = requireConfirmedAction(args, options, operation === 'clear' ? 'Setup wizard checkpoint clear' : 'Setup wizard checkpoint save');
    if (confirmationError) return error(confirmationError);
    const result = operation === 'clear'
      ? clearSetupCheckpoint(deps.commandContext, args, options)
      : await markSetupCheckpoint(deps.commandContext, args, options);
    const innerStatus = result.status;
    const written = result.done === true;
    return effectOutput({ status: written ? 'checkpoint_action_completed' : typeof innerStatus === 'string' ? innerStatus : 'checkpoint_not_written',
      done: written, reason: typeof result.reason === 'string' ? result.reason : 'no setup checkpoint was written.',
      action: describeWorkspaceAction(category, action, { lookup }), result });
  }
  if (action.kind === 'editor' && action.editorKind) {
    const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
    // An editor built on the empty fallback context has no selected routine, templates or handoff artifacts to act on.
    if (editorContext?.contextUnavailable && EDITOR_KINDS_USING_RUNTIME_CONTEXT.has(action.editorKind)) {
      return error(`Workspace action ${action.id} was not run and nothing was changed: ${editorContext.contextUnavailable} Fix the cause, then call this action again.`);
    }
    const editor = createWorkspaceEditor(action.editorKind, editorContext);
    if (!editor) return error(`No workspace editor route exists for ${action.editorKind}.`);
    return runWorkspaceEditorAction(deps, action, editor, args, options);
  }
  if (action.kind === 'local-selection' || action.kind === 'local-operation') {
    return runLocalWorkspaceAction(deps, action, args, options);
  }
  if (action.kind === 'onboarding-complete') {
    const confirmationError = requireConfirmedAction(args, options, 'Onboarding completion');
    if (confirmationError) return error(confirmationError);
    const explicitUserRequest = readString(args.explicitUserRequest);
    const shellPaths = deps.commandContext.workspace?.shellPaths;
    if (!shellPaths) return error('Onboarding completion requires Agent shell paths.');
    const assertCurrent = captureHarnessLocalEffect(deps.commandContext, args, options, paths => [getOnboardingCheckMarkerPath(paths), getOnboardingCompletionMarkerPath(paths)]);
    const marker = { scope: 'user', source: 'wizard', mode: 'new', workspaceRoot: shellPaths.workingDirectory } as const;
    assertCurrent();
    const checkMarker = writeOnboardingCheckMarker(shellPaths, marker);
    assertCurrent();
    const completionMarker = writeOnboardingCompletionMarker(shellPaths, marker);
    return output({
      status: 'onboarding_completed',
      action: describeWorkspaceAction(category, action, { lookup }),
      explicitUserRequest,
      checkMarker: {
        exists: checkMarker.exists,
        updatedAt: checkMarker.payload?.updatedAt ?? null,
        source: checkMarker.payload?.source ?? null,
        mode: checkMarker.payload?.mode ?? null,
      },
      completionMarker: {
        exists: completionMarker.exists,
        updatedAt: completionMarker.payload?.updatedAt ?? null,
        source: completionMarker.payload?.source ?? null,
        mode: completionMarker.payload?.mode ?? null,
      },
      routes: {
        inspectSetup: 'setup action:"status" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-onboarding-marker-write',
        boundary: 'Writes only the user onboarding check and completion markers. It does not mutate provider credentials, connected-host state, channels, schedules, or local behavior.',
      },
    });
  }
  const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
  return effectOutput({
    status: 'no_direct_effect',
    done: false,
    reason: 'This workspace action has no effect run_workspace_action can perform; nothing was run. Use the routes in its description.',
    action: describeWorkspaceAction(category, action, { includeEditor: true, editorContext, lookup }),
  });
}
