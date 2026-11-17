/** One-shot delivery owners; no daemon graph, listener, poller or notification queue. */
import { ChannelDeliveryRouter } from '@goodvibes-jev/engine/platform/platform/channels';
import { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { ServiceRegistry, SubscriptionManager, createRuntimeSecretsManager, sharedSubscriptionsPath } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import type { DaemonCliConfiguration } from '../../cli/configuration.js';
import type { SendDeliver } from './command.js';

/** Call only after parsing, channel/gate admission and complete message acquisition. */
export function createSendStack(configuration: DaemonCliConfiguration): { readonly deliver: SendDeliver } {
  const { config, workingDirectory, homeDirectory, daemonHomeDirectory } = configuration;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory, globalHome: homeDirectory, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    daemonHome: daemonHomeDirectory, configManager: config, diagnosticMode: 'structural',
  });
  const serviceRegistry = new ServiceRegistry({ user: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json'), project: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json') }, {
    secretsManager, diagnosticMode: 'structural',
    // Secret resolution does not consult subscriptions. One-shot send must not
    // trigger an unrelated legacy subscription migration while acquiring them.
    subscriptionManager: new SubscriptionManager(sharedSubscriptionsPath(shellPaths)),
  });
  const router = new ChannelDeliveryRouter({ configManager: config, secretsManager, serviceRegistry,
    artifactStore: new ArtifactStore({ configManager: config }) });
  return { deliver: (request) => router.deliver(request) };
}
