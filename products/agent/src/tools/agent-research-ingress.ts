import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolInputProjector, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { agentResearchReportSourceOwner, captureResearchInput, hasPreparedResearchReport, inheritPreparedResearchReport, prepareProtectedResearchReport } from '@goodvibes-jev/engine/terminal-shell/agent-turn/protected-research-report';
import { resolveWorkspaceActionIdentity } from './agent-harness-workspace-actions.ts';
import { forwardHarnessCatalogCall, harnessCatalogExecutionGuard } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ingress';

export function isResearchReportEditor(args: Record<string, unknown>): boolean {
  if (args.mode === 'run_workspace_action') {
    const resolved = resolveWorkspaceActionIdentity(args);
    // Other editors can legitimately have a field named sources (for example,
    // browser-history import). Their explicit route retains its own boundary.
    if (resolved?.status === 'found') return resolved.action.editorKind === 'research-report';
  }
  return !!args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
    && ['sources', 'reportMarkdown'].some(key => Object.hasOwn(args.fields as object, key));
}

/** Report fields must be projected before the harness itself becomes a generic reader. */
export function createAgentHarnessResearchProjector(registry: ToolRegistry, isReport = isResearchReportEditor): ToolInputProjector {
  return { async project(request) {
    const args = captureResearchInput(request.args);
    if (!isReport(args)) return { status: 'projected', args, assertRepairedArgs(candidate) {
      if (isReport(candidate)) throw new Error('Research editor input requires fresh protected preparation.');
    } };
    const fields = args.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { status: 'held' };
    const prepared = await prepareProtectedResearchReport(agentResearchReportSourceOwner(registry), {
      ...args, sources: (fields as Record<string, unknown>).sources,
    }, { signal: request.signal, assertCurrent: request.assertCurrent });
    const { sources: _sources, ...projected } = prepared.args;
    const serialized = JSON.stringify(projected);
    inheritPreparedResearchReport(prepared.args, projected);
    return { status: 'projected', args: projected, assertCurrent: prepared.assertCurrent, release: prepared.release,
      assertRepairedArgs(candidate) {
        prepared.assertCurrent();
        if (JSON.stringify(candidate) !== serialized) throw new Error('Research editor input binding changed.');
        inheritPreparedResearchReport(projected, candidate);
      },
    };
  } };
}

/** Read only the routing fields; unrelated private setup bodies keep their own boundary. */
function reportRouting(input: Record<string, unknown>): Record<string, unknown> {
  const routing: Record<string, unknown> = {};
  for (const key of ['mode', 'action', 'id', 'actionId', 'workspaceActionId', 'command', 'target', 'query', 'category', 'categoryId']) {
    if (Object.hasOwn(input, key)) routing[key] = input[key];
  }
  const fields = input.fields;
  if (fields && typeof fields === 'object') {
    routing.fields = Object.fromEntries(['sources', 'reportMarkdown'].filter(key => Object.hasOwn(fields, key)).map(key => [key, '']));
  }
  return routing;
}

/** Raw factory callers retain the same report boundary as registered callers. */
export function protectAgentHarnessResearchTool(tool: Tool, registry: ToolRegistry, isReport = isResearchReportEditor): Tool {
  const execute = tool.execute;
  const originalBody: Tool = { definition: tool.definition, execute: (input, options) => execute(input, options) };
  const projector = createAgentHarnessResearchProjector(registry, isReport);
  return { ...tool, async execute(input, options) {
    if (!isReport(reportRouting(input))) return execute(input, options);
    const args = captureResearchInput(input);
    if (!isReport(args)) return execute(input, options);
    if (hasPreparedResearchReport(input, agentResearchReportSourceOwner(registry))) return execute(input, options);
    const assertCurrent = harnessCatalogExecutionGuard(input, options);
    const projected = await projector.project({ callId: 'research-editor-direct', name: tool.definition.name, args,
      signal: options?.signal, assertCurrent });
    try {
      if (projected.status !== 'projected') return { success: false, error: 'Research report not run: the form fields are missing. Pass fields with sources and reportMarkdown, then call again.' };
      projected.assertCurrent?.();
      return await forwardHarnessCatalogCall(originalBody, input, projected.args, options, projected.assertCurrent);
    } finally { await projected.release?.(); }
  } };
}
