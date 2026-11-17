import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { buildAgentDocumentReviewerReadinessToolArgs, buildAgentDocumentReviewPacketWizardToolArgs } from '../input/agent-workspace-document-ops-editor.ts';
import { buildAgentWorkspaceCommandEditorSubmission, isAgentWorkspaceCommandEditorKind } from '../input/agent-workspace-command-editor.ts';
import { isAffirmative, isEnabledValue, splitList } from '../input/agent-workspace-editors.ts';
import { createAgentWorkspaceLearnedBehavior } from '../input/agent-workspace-learned-behavior.ts';
import type { AgentWorkspaceAction, AgentWorkspaceLocalEditor } from '../input/agent-workspace-types.ts';
import { describeDocumentOpsLane } from './agent-harness-document-ops.ts';
import { runLocalWorkspaceEditorAction } from './agent-harness-local-operations.ts';
import { describeWorkspaceEditorModelExecution, workspaceEditorToolCall } from './agent-harness-workspace-editor-execution.ts';
import { describeWorkspaceEditor } from './agent-harness-workspace-actions.ts';
import { runTranslatedWorkspaceCommand } from './agent-harness-command-runner.ts';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';
import { harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { personaStorePath } from '../agent/persona-registry.ts';
import { skillStorePath } from '../agent/skill-registry.ts';
import { routineStorePath } from '../agent/routine-registry.ts';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { effectOutput, error, nestedToolOutput, output, readFieldMap, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';

function fieldReader(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): (fieldId: string) => string {
  return (fieldId: string) => fields[fieldId] ?? editor.fields.find((field) => field.id === fieldId)?.value ?? '';
}

function modelEditorToolArgs(built: object, suppliedRequest: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(built)) {
    if (key !== 'confirm' && key !== 'explicitUserRequest') payload[key] = value;
  }
  const request = readString(suppliedRequest);
  if (Object.hasOwn(built, 'explicitUserRequest') && request) payload.explicitUserRequest = request;
  return payload;
}

function missingRequiredEditorFields(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): readonly string[] {
  const readField = fieldReader(editor, fields);
  return editor.fields
    .filter((field) => field.id !== 'confirm' && field.id !== 'explicitUserRequest' && field.required && !readField(field.id).trim())
    .map((field) => field.id);
}

export async function runWorkspaceEditorAction(
  deps: AgentHarnessToolDeps,
  action: AgentWorkspaceAction,
  editor: AgentWorkspaceLocalEditor,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const fields = readFieldMap(args.fields);
  const missing = missingRequiredEditorFields(editor, fields);
  if (missing.length > 0) {
    return effectOutput({
      status: 'missing_required_fields',
      done: false,
      reason: `Required fields are empty: ${missing.join(', ')}. Nothing was run; fill them and call again.`,
      missing,
      action: action.id,
      editor: describeWorkspaceEditor(editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  // Recorded admission is the authority to run, but a form answer of "no" is the person
  // saying not to, so it is honoured; an absent or blank answer defers to admission.
  const answered = fields.confirm?.trim();
  if (answered && !isAffirmative(answered)) {
    return error(`Workspace action ${action.id} was not run and nothing was changed: fields.confirm is "${answered.slice(0, 20)}". Pass fields.confirm:"yes" or omit it to run the action under the current recorded effect admission.`);
  }

  if (editor.kind === 'learned-behavior') {
    const confirmationError = requireConfirmedAction(args, options, 'Workspace learned-behavior capture');
    if (confirmationError) return error(confirmationError);
    const shellPaths = deps.commandContext.workspace.shellPaths;
    if (!shellPaths) return error('Agent shell paths are unavailable.');
    const readField = fieldReader(editor, fields);
    const target = readField('target').trim().toLowerCase();
    if (target !== 'skill' && target !== 'routine' && target !== 'persona') {
      return error('learned-behavior target must be skill, routine, or persona.');
    }
    const assertCurrent = captureHarnessLocalEffect(deps.commandContext, args, options, paths => [
      target === 'persona' ? personaStorePath(paths) : target === 'skill' ? skillStorePath(paths) : routineStorePath(paths),
    ]);
    const created = createAgentWorkspaceLearnedBehavior(shellPaths, {
      target,
      name: readField('name'),
      description: readField('description'),
      notes: readField('notes'),
      tags: splitList(readField('tags')),
      triggers: splitList(readField('triggers')),
      enable: isEnabledValue(readField('enable')),
    }, assertCurrent);
    return output({
      status: 'created',
      kind: created.kind,
      id: created.id,
      name: created.name,
      policy: 'Agent-local behavior only; no connected-host mutation, default knowledge write, or delegated job was created.',
    });
  }

  if (editor.kind === 'profile') {
    const readField = fieldReader(editor, fields);
    const name = readField('name');
    const template = readField('template');
    const useTemplate = template.trim() !== '' && template.trim().toLowerCase() !== 'none';
    // A value that starts with `--` would be read as a flag, so the profile
    // created would differ from the one the person reviewed.
    const flagLike = [['name', name], ...(useTemplate ? [['template', template]] : [])].find(([, value]) => value!.trim().startsWith('--'));
    if (flagLike) return error(`Profile ${flagLike[0]} "${flagLike[1]}" starts with "--" and would be read as a command flag. Choose a ${flagLike[0]} that does not start with "--".`);
    const command = ['/agent-profile', 'create', JSON.stringify(name), ...(useTemplate ? ['--template', JSON.stringify(template)] : []), '--yes'].join(' ');
    return runTranslatedWorkspaceCommand(deps, args, command, options);
  }

  // A form whose work is one tool call: the same call the owner's own submit makes.
  const toolCall = workspaceEditorToolCall(editor);
  if (toolCall) {
    if (toolCall.confirmation) {
      const confirmationError = requireConfirmedAction(args, options, toolCall.confirmation);
      if (confirmationError) return error(confirmationError);
    }
    const built = toolCall.build(fieldReader(editor, fields), readString(args.explicitUserRequest));
    const result = await deps.toolRegistry.executeNested(toolCall.callId, toolCall.tool, modelEditorToolArgs(built, args.explicitUserRequest), options);
    return nestedToolOutput(result, {
      action: action.id,
      tool: toolCall.tool,
      output: result.output ?? null,
      error: result.error ?? null,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  if (editor.kind === 'document-reviewer-readiness') {
    const readinessArgs = buildAgentDocumentReviewerReadinessToolArgs(fieldReader(editor, fields));
    const reading = { signal: options?.signal, sourceOwner: agentResearchSourceOwner(deps.toolRegistry),
      assertCurrent: harnessCatalogExecutionGuard(args, options), retainCurrent: retainHarnessCatalogCurrent(args) };
    const resolved = await describeDocumentOpsLane(deps.commandContext, readinessArgs, reading);
    reading.assertCurrent();
    if (resolved.status !== 'found') {
      return error(resolved.status === 'ambiguous'
        ? `Ambiguous Document Ops lane reviewer_readiness. Candidates: ${JSON.stringify(resolved.candidates)}`
        : resolved.usage);
    }
    return output({
      status: 'executed_harness_lane',
      action: action.id,
      tool: 'agent_harness',
      output: resolved.lane,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (editor.kind === 'document-review-packet-wizard') {
    const wizardArgs = buildAgentDocumentReviewPacketWizardToolArgs(fieldReader(editor, fields));
    const reading = { signal: options?.signal, sourceOwner: agentResearchSourceOwner(deps.toolRegistry),
      assertCurrent: harnessCatalogExecutionGuard(args, options), retainCurrent: retainHarnessCatalogCurrent(args) };
    const resolved = await describeDocumentOpsLane(deps.commandContext, wizardArgs, reading);
    reading.assertCurrent();
    if (resolved.status !== 'found') {
      return error(resolved.status === 'ambiguous'
        ? `Ambiguous Document Ops lane review_packet_wizard. Candidates: ${JSON.stringify(resolved.candidates)}`
        : resolved.usage);
    }
    return output({
      status: 'executed_harness_lane',
      action: action.id,
      tool: 'agent_harness',
      output: resolved.lane,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }
  if (!isAgentWorkspaceCommandEditorKind(editor.kind)) {
    if (
      editor.kind === 'memory'
      || editor.kind === 'note'
      || editor.kind === 'persona'
      || editor.kind === 'skill'
      || editor.kind === 'routine'
    ) {
      return runLocalWorkspaceEditorAction(deps, editor, args, options);
    }
    return effectOutput({
      status: 'model_tool_required',
      done: false,
      reason: 'This form is not run by run_workspace_action; nothing was run. Use the first-class tool named in modelExecution.',
      action: action.id,
      editor: describeWorkspaceEditor(editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
    });
  }

  const submission = buildAgentWorkspaceCommandEditorSubmission(
    editor,
    fieldReader(editor, fields),
    true,
    true,
  );
  if (submission.kind === 'editor') {
    return output({
      status: submission.status,
      action: action.id,
      editor: describeWorkspaceEditor(submission.editor),
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
      actionResult: submission.actionResult ?? null,
    });
  }
  if (submission.kind === 'prompt') {
    return output({
      status: submission.status,
      action: action.id,
      prompt: submission.prompt,
      actionResult: submission.actionResult,
      modelExecution: describeWorkspaceEditorModelExecution(editor.kind),
      note: 'This workspace action submits a normal main-conversation prompt in the TUI. In model-tool context, use the returned prompt as the conversation task instead of creating a hidden nested turn.',
    });
  }
  return runTranslatedWorkspaceCommand(deps, args, submission.command, options);
}
