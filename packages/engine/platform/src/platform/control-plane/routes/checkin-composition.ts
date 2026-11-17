/** The real registered check-in caller, shared by runtime composition and synthetic route tests. */
import { CheckinService, CheckinReceiptStore, createProviderBackedCheckinJudge } from '../../checkin/index.js';
import { createRuntimeCheckinStateReader, judgeOnlyWhenOwnerNeeded } from '../../checkin/state-reader.js';
import type { ConfigKey } from '../../config/schema.js';
import { parseChannelDeliveryTarget } from '../../channels/delivery/types.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayVerbGroupDeps } from './register-gateway-verb-groups.js';
import { registerCheckinGatewayMethods } from './checkin.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { controlPlaneStorePath } from '../control-plane-store-paths.js';

export function registerComposedCheckinGatewayMethods(catalog: GatewayMethodCatalog, deps: Pick<GatewayVerbGroupDeps,
  'channelDeliveryRouter' | 'providerRegistry' | 'automationManager' | 'sessionLister' | 'configManager' | 'shellPaths' | 'surfaceRoot' | 'disposal' | 'ownerInbox' | 'listContracts'>): void {
  if (deps.channelDeliveryRouter && deps.providerRegistry && deps.automationManager && deps.sessionLister && deps.configManager.onDidInvalidate) {
    const channelDeliveryRouter = deps.channelDeliveryRouter;
    const automation = deps.automationManager;
    const sessionLister = deps.sessionLister;
    // The check-in reads its checkin.* ConfigKeys through a string-keyed
    // surface; adapt the daemon's ConfigManager to it.
    const configManager = deps.configManager;
    const onDidInvalidate = deps.configManager.onDidInvalidate.bind(configManager);
    const subscribe = configManager.subscribe?.bind(configManager);
    const resolveForConsumer = configManager.resolveForConsumer?.bind(configManager);
    const checkinConfig = {
      get: (key: string): unknown => configManager.get(key as ConfigKey),
      ...(resolveForConsumer ? { resolveForConsumer: (key: string): unknown => resolveForConsumer(key as ConfigKey) } : {}),
      onDidInvalidate: (listener: () => void) => onDidInvalidate(listener),
      ...(subscribe ? { subscribe: (key: string, listener: () => void) => subscribe(key as ConfigKey, listener) } : {}),
      set: (key: string, value: string | boolean): void => configManager.set(key as ConfigKey, value as never),
    };
    const ownerInbox = deps.ownerInbox;
    const listContracts = deps.listContracts;
    const stateReader = createRuntimeCheckinStateReader({
      listSessions: () => sessionLister.listSessions(500),
      listRuns: () => automation.listRuns(),
      ...(ownerInbox ? { listOwnerItems: () => ownerInbox.listNow({ status: 'open' }) } : {}),
      // A contract escalation waits in the contract, not the owner inbox.
      ...(listContracts ? { listContracts } : {}),
    });
    const checkinService = new CheckinService({
      config: checkinConfig,
      stateReader,
      judge: judgeOnlyWhenOwnerNeeded(createProviderBackedCheckinJudge(deps.providerRegistry), stateReader),
      deliverer: {
        deliver: async (channel, message, lifetime) => {
          return channelDeliveryRouter.deliver({
            target: parseChannelDeliveryTarget(channel),
            body: message,
            title: 'Check-in',
            ...(lifetime ? { signal: lifetime.signal, assertCurrent: lifetime.assertCurrent } : {}),
            jobId: 'checkin',
            runId: `checkin-${Date.now()}`,
            includeLinks: false,
          });
        },
      },
      receipts: new CheckinReceiptStore(controlPlaneStorePath(deps.shellPaths, deps.surfaceRoot, 'checkin-receipts.json')),
      automation,
    });
    deps.disposal?.add('check-in evaluation lifetime', () => checkinService.dispose());
    registerCheckinGatewayMethods(catalog, checkinService);
    // A schedule that could not be installed (automation off, an unreadable
    // automation store) is the service's `schedule` status, which
    // checkin.config.get returns; turning automation on re-syncs it at once.
    void checkinService.attach().catch((error: unknown) => {
      logger.warn('check-in: the scheduler did not take the check-in evaluator; scheduled check-ins will not run until the daemon restarts', {
        error: summarizeError(error),
      });
    });
  }

}
