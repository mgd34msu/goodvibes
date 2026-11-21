import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { AGENT_WORKSPACE_CATEGORIES, describeWorkspaceAction, describeWorkspaceCategory, readFieldMap, resolveWorkspaceActionDetail, workspaceRowLine } from './agent-harness-workspace-actions.ts';
import { runTranslatedWorkspaceCommand } from './agent-harness-command-runner.ts';
import { effectOutput, error, output, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { formatHarnessError } from '../agent/harness-control.ts';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools';
import { executeAdmittedAgentSettingsImport, isAgentSettingsImportMutation } from './agent-settings-import-admission.ts';
import { agentResearchSourceOwner } from '@goodvibes/engine/terminal-shell/agent-turn/protected-research-report';
import { assertModelReadingInputCurrent, captureModelReadingInput, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturedHarnessSettingsImportPreview, harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { getOnboardingCheckMarkerPath, getOnboardingCompletionMarkerPath, writeOnboardingCheckMarker, writeOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';

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
    return output({
      status: 'guidance',
      action: describeWorkspaceAction(category, action, { includeBlanks: true, lookup }),
    });
  }
  // A row that runs a described action runs its typed line, with the model's
  // `fields` for the blanks, through the same command runner as run_command:
  // a missing blank is refused with its choices, an owner-only action is refused.
  if (action.kind === 'act' && action.act) {
    const line = workspaceRowLine(action, readFieldMap(args.fields));
    if (!line) return error(`Workspace action ${action.id} names no command.`);
    return runTranslatedWorkspaceCommand(deps, args, line, options);
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
  if (action.kind === 'onboarding-complete') {
    const confirmationError = requireConfirmedAction(args, options, 'Onboarding completion');
    if (confirmationError) return error(confirmationError);
    const explicitUserRequest = readString(args.explicitUserRequest);
    const shellPaths = deps.commandContext.workspace?.shellPaths;
    if (!shellPaths) return error('Onboarding completion requires Agent shell paths.');
    const assertCurrent = captureHarnessLocalEffect(deps.commandContext, args, options, paths => [getOnboardingCheckMarkerPath(paths), getOnboardingCompletionMarkerPath(paths)]);
    const marker = { scope: 'user', source: 'wizard', mode: 'new', workspaceRoot: shellPaths.workingDirectory } as const;
    assertCurrent();
    // The completion marker decides whether setup is done, so it is written first:
    // a failure before it leaves nothing that reads as done.
    const completionMarker = writeOnboardingCompletionMarker(shellPaths, marker);
    let checkMarker: ReturnType<typeof writeOnboardingCheckMarker>;
    try {
      assertCurrent();
      checkMarker = writeOnboardingCheckMarker(shellPaths, marker);
    } catch (err) {
      return error(`Setup was marked complete, so later starts open the conversation, but the compatibility check marker could not be written: ${formatHarnessError(err)}`);
    }
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
  return effectOutput({
    status: 'no_direct_effect',
    done: false,
    reason: 'This workspace action has no effect run_workspace_action can perform; nothing was run. Use the routes in its description.',
    action: describeWorkspaceAction(category, action, { includeBlanks: true, lookup }),
  });
}
