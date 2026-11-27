/**
 * The Agent process's side of a protected catalog call's admission. The
 * admission itself is the shared Agent turn's (agent-turn/catalog-ingress.ts);
 * this adds what only this process has, its command context: the settings a
 * call inspects, the live session and MCP registry it reads, and the channel
 * drafts and setup smoke runs a call names.
 */
import { agentDaemonConfigClientRevision } from '../config/daemon-config-routing.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import type { ToolInputProjector, ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { createCatalogInputProjector, isHarnessCatalogQuery, protectCatalogTool, type CatalogIngressContext } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ingress';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { createChannelDraftReferenceCapture } from './agent-channel-draft-reference.ts';
import { createSetupSmokeReferenceCapture } from './agent-setup-smoke-reference.ts';

export { catalogRoutingInput, forwardHarnessCatalogCall, harnessCatalogExecutionGuard, harnessCatalogInvocationAuthority, isHarnessCatalogQuery, retainHarnessCatalogCurrent } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ingress';

/** The command context's sources a protected call reads: its settings when it inspects them, the live session and the MCP registry. */
function commandSourceGuard(context: CommandContext | undefined, settings: boolean): () => void {
  const platform = settings ? context?.platform : undefined;
  const config = platform?.configManager;
  const incarnation = config?.getConfigurationIncarnation();
  const clientRevision = settings ? agentDaemonConfigClientRevision() : undefined;
  const session = modelReadingServicePath(context, ['session', 'runtime']);
  const sessionId = modelReadingServicePath(session, ['sessionId']);
  const api = modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry']);
  return () => {
    const currentConfig = settings ? context?.platform.configManager : undefined;
    const currentIncarnation = config?.getConfigurationIncarnation();
    if ((settings && (currentConfig !== config || currentIncarnation !== incarnation || agentDaemonConfigClientRevision() !== clientRevision))
      || modelReadingServicePath(context, ['session', 'runtime']) !== session || modelReadingServicePath(session, ['sessionId']) !== sessionId
      || (modelReadingServicePath(context, ['clients', 'mcpApi']) ?? modelReadingServicePath(context, ['extensions', 'mcpRegistry'])) !== api) throw new ToolInputProjectionError('stale');
  };
}

/** What this process adds to a protected call's admission. */
function harnessIngressContext(context?: CommandContext): CatalogIngressContext {
  const captureChannel = createChannelDraftReferenceCapture(context);
  const captureSmoke = createSetupSmokeReferenceCapture(context);
  return {
    captureNativeReferences: request => captureChannel(request) ?? captureSmoke(request),
    sourceGuard: settings => commandSourceGuard(context, settings),
  };
}

/** Reuse the protected-source owner and full original invocation projector. */
export function createHarnessCatalogInputProjector(registry: ToolRegistry, fallback?: ToolInputProjector,
  selected = isHarnessCatalogQuery, context?: CommandContext): ToolInputProjector {
  return createCatalogInputProjector(registry, fallback, selected, harnessIngressContext(context));
}

/** Raw factory callers use the same full-source boundary as registered callers. */
export function protectHarnessCatalogTool(tool: Tool, registry: ToolRegistry, selected = isHarnessCatalogQuery, context?: CommandContext): Tool {
  return protectCatalogTool(tool, registry, selected, harnessIngressContext(context));
}
