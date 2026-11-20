import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { readOnboardingDoneMarker } from '../runtime/onboarding/completion.ts';
import { resolveWebUiOrigin } from '@goodvibes-jev/engine/platform/platform/pairing';

/** The Agent's own onboarding marker, read from its file. */
function agentOnboarding(context: CommandContext, includeDetails: boolean): Record<string, unknown> {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { status: 'unavailable', reason: 'Agent shell paths are unavailable in this runtime.' };
    // The same answer start-up and status give: a damaged marker is not done.
    const completion = readOnboardingDoneMarker(shellPaths);
    return {
      status: completion.payload !== null ? 'complete' : 'missing',
      ...(completion.exists && completion.payload === null ? { reason: `The setup marker at ${completion.path} cannot be read; setup is offered again.` } : {}),
      ...(includeDetails ? {
        scope: 'user',
        updatedAt: completion.payload?.updatedAt ?? null,
        source: completion.payload?.source ?? null,
        mode: completion.payload?.mode ?? null,
      } : {}),
    };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'Unable to read Agent onboarding completion marker.' };
  }
}

/**
 * The connected browser cockpit, from facts this program holds: where the web
 * UI is served (the engine's one owner of that address: the daemon's
 * control-plane listener while it serves the bundle, else a set
 * `web.publicBaseUrl`; `web.port` is only a development server's) and the
 * Agent's own onboarding marker. The web UI has its own views (chat, work, library,
 * personal, phone, settings) and does not mirror the Agent workspace's
 * categories, so no category, touch or install coverage is claimed for it.
 */
export async function connectedBrowserCockpitRoute(context: CommandContext, rawOptions: { readonly includeWorkspaceCoverage?: boolean } = {}, readingOptions: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  readingOptions.signal?.throwIfAborted(); readingOptions.assertCurrent?.();
  const includeDetails = rawOptions.includeWorkspaceCoverage === true;
  const configManager = context.platform?.configManager;
  let enabled = false;
  let binding = { hostMode: 'local', configuredHost: '127.0.0.1', host: '127.0.0.1', port: 3423 };
  let servedUrl = '';
  let servedByDaemon = false;
  let configFailure: string | undefined;
  if (configManager) {
    try {
      enabled = configManager.get('web.enabled') === true;
      binding = resolveRuntimeEndpointBinding(configManager, 'web');
      servedByDaemon = configManager.get('controlPlane.webui.serve') === true;
      servedUrl = resolveWebUiOrigin(configManager)?.origin ?? '';
    } catch (error) {
      // A config that cannot be read is not the same as a web endpoint that is switched off.
      configFailure = error instanceof Error ? error.message : 'The web endpoint configuration could not be read.';
      enabled = false;
    }
  }
  const url = configFailure ? '' : servedUrl;
  return {
    enabled,
    ...(configFailure ? { status: 'unavailable', reason: configFailure } : {}),
    // No web UI served anywhere the settings name is setup still to do, whatever web.enabled says.
    readiness: configFailure ? 'unavailable' : url ? 'ready' : 'setup-needed',
    url,
    source: servedByDaemon ? 'the daemon\'s control-plane listener (controlPlane.webui.serve)' : url ? 'web.publicBaseUrl' : 'none: no web UI is served (goodvibes-daemon webui enable --bundle-dir <dir>)',
    endpoint: {
      id: 'web',
      binding,
      settings: ['web.enabled', 'web.hostMode', 'web.host', 'web.port', 'web.publicBaseUrl'],
    },
    agentOnboarding: agentOnboarding(context, includeDetails),
    webViews: 'The web UI opens on chat, work, library, personal, phone and settings views; Agent workspace categories stay in the terminal Agent Workspace.',
    setupRoutes: {
      inspectEndpoint: 'host action:"service" endpointId:"web"',
      servicePosture: 'host action:"services" includeParameters:true',
      connectedHostStatus: 'host action:"status" includeParameters:true',
      settings: 'settings action:"list" query:"web" includeHidden:true',
      setupCloseout: 'setup action:"status" includeParameters:true',
    },
    policy: 'Opens the connected GoodVibes browser cockpit only after explicit user confirmation. Agent does not host a separate browser app or bypass connected-host setup.',
  };
}
