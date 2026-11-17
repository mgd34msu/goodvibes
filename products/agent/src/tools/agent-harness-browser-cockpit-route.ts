import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { readOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { urlHostForConfiguredHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/** This browser opens on THIS host, so a wildcard bind resolves to loopback. */
const browserConnectHost = urlHostForConfiguredHost;

/** The Agent's own onboarding marker, read from its file. */
function agentOnboarding(context: CommandContext, includeDetails: boolean): Record<string, unknown> {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return { status: 'unavailable', reason: 'Agent shell paths are unavailable in this runtime.' };
    const completion = readOnboardingCompletionMarker(shellPaths, 'user');
    return {
      status: completion.exists ? 'complete' : 'missing',
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
 * The connected browser cockpit, from facts this program holds: the web
 * endpoint's settings (enabled, binding, public URL) and the Agent's own
 * onboarding marker. The web UI has its own views (chat, work, library,
 * personal, phone, settings) and does not mirror the Agent workspace's
 * categories, so no category, touch or install coverage is claimed for it.
 */
export async function connectedBrowserCockpitRoute(context: CommandContext, rawOptions: { readonly includeWorkspaceCoverage?: boolean } = {}, readingOptions: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  readingOptions.signal?.throwIfAborted(); readingOptions.assertCurrent?.();
  const includeDetails = rawOptions.includeWorkspaceCoverage === true;
  const configManager = context.platform?.configManager;
  let enabled = false;
  let binding = { hostMode: 'local', configuredHost: '127.0.0.1', host: '127.0.0.1', port: 3423 };
  let publicBaseUrl = '';
  let configFailure: string | undefined;
  if (configManager) {
    try {
      enabled = configManager.get('web.enabled') === true;
      binding = resolveRuntimeEndpointBinding(configManager, 'web');
      publicBaseUrl = String(configManager.get('web.publicBaseUrl') ?? '').trim();
    } catch (error) {
      // A config that cannot be read is not the same as a web endpoint that is switched off.
      configFailure = error instanceof Error ? error.message : 'The web endpoint configuration could not be read.';
      enabled = false;
    }
  }
  const url = configFailure ? '' : publicBaseUrl || `http://${browserConnectHost(binding.host)}:${binding.port}`;
  return {
    enabled,
    ...(configFailure ? { status: 'unavailable', reason: configFailure } : {}),
    readiness: configFailure ? 'unavailable' : enabled ? 'ready' : 'setup-needed',
    url,
    source: publicBaseUrl ? 'web.publicBaseUrl' : 'web endpoint binding',
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
