/** One-shot delivery owners; no daemon graph, listener, poller or notification queue. */
import { ChannelDeliveryRouter } from '@goodvibes/engine/platform/platform/channels';
import { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { ServiceRegistry, SubscriptionManager, createRuntimeSecretsManager, sharedSubscriptionsPath } from '@goodvibes/engine/platform/platform/config';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { daemonRecordsRoot } from '../../runtime/daemon-records.js';
import type { DaemonCliConfiguration } from '../../cli/configuration.js';
import type { SendDeliver } from './command.js';

/** Call only after parsing, channel/gate admission and complete message acquisition. */
export function createSendStack(configuration: DaemonCliConfiguration): { readonly deliver: SendDeliver } {
  const { config, workingDirectory, homeDirectory, daemonHomeDirectory } = configuration;
  // The daemon's services file is one of its records, in its home (runtime/daemon-records.ts).
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory, recordsRoot: daemonRecordsRoot(daemonHomeDirectory) });
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory, globalHome: homeDirectory, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    daemonHome: daemonHomeDirectory, configManager: config, diagnosticMode: 'structural',
  });
  const serviceRegistry = new ServiceRegistry({ user: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json'), project: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json') }, {
    secretsManager, diagnosticMode: 'structural',
    // Secret resolution does not consult subscriptions. One-shot send must not
    // trigger an unrelated legacy subscription migration while acquiring them.
    subscriptionManager: new SubscriptionManager(sharedSubscriptionsPath(shellPaths), { secrets: secretsManager }),
  });
  const router = new ChannelDeliveryRouter({ configManager: config, secretsManager, serviceRegistry,
    artifactStore: new ArtifactStore({ configManager: config }) });
  return { deliver: (request) => router.deliver(request) };
}
