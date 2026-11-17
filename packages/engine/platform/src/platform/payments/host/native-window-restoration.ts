/** Native startup capabilities, composed by the actual daemon root. Stored
 * authority/page identifiers identify what must be independently reacquired;
 * they cannot mint either capability. No bearer or card data is loaded here. */
import { isDeepStrictEqual } from 'node:util';
import type { PairingTokenManager } from '../../pairing/pairing-token-store.js';
import type { GatewayMethodCatalog, GatewayScopePolicyOwner } from '../../control-plane/method-catalog.js';
import { waitForGatewayScopePolicyBootstrap } from '../../control-plane/scope-policy-bootstrap.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import type { ChannelDeliveryRouter } from '../../channels/index.js';
import type { ChannelDeliveryRouteBinding } from '../../channels/delivery/types.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { captureBrowserCheckoutRecovery } from '../../browser/browser-checkout-recovery-data.js';
import type { RestoredCheckoutPage } from '../../browser/browser-engine.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { readPaymentsEnabled, readPaymentsServiceConfig, type PaymentsConfigReader } from '../payments-config.js';
import type { PaymentNoticeTarget } from '../notice-delivery.js';
import { capturePaymentNoticeReceipt } from '../notice-receipt.js';
import { PaymentReplyWindowError, type PaymentReplyInbox } from '../reply-inbox.js';
import { recoverInterruptedWindow } from '../windows.js';
import { daemonNoticeRouter, purchaseInboxKey } from './notifier.js';
import { prepareRestoredPaymentReplyWindow, type RestoredInboxWindow } from './restored-reply-window.js';
import type { CheckoutComposition } from './checkout-handlers.js';
import { missingScopes } from '@goodvibes-jev/engine/daemon-api/route-helpers';

const telegramNumber = (value: string | undefined, negative = false): boolean => value !== undefined
  && (negative ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(value) && Number.isSafeInteger(Number(value));

export interface NativeCheckoutWindowRestorationOptions {
  readonly pairing: Pick<PairingTokenManager, 'readNativeContinuation' | 'withNativeContinuation' | 'revokeNativeContinuation'>;
  readonly catalog: GatewayMethodCatalog;
  readonly scopes: Pick<GatewayScopePolicyOwner, 'grantedScopes'>;
  readonly config: PaymentsConfigReader;
  readonly seam: () => BrowserCheckoutSeam | undefined;
  readonly replies: PaymentReplyInbox;
  readonly router: Pick<ChannelDeliveryRouter, 'deliver'> & Partial<Pick<ChannelDeliveryRouter, 'deliverWithReceipt'>>;
  readonly isPaymentsLeader: () => boolean;
  /** The owner inbox window notices are posted to; a window that reached it resumes from its item. */
  readonly ownerInbox?: RestoredInboxWindow['port'] | undefined;
}

export function createNativeCheckoutWindowRestorer(options: NativeCheckoutWindowRestorationOptions): NonNullable<CheckoutComposition['restoreWindow']> {
  const read = options.pairing.readNativeContinuation.bind(options.pairing);
  const withGrant = options.pairing.withNativeContinuation.bind(options.pairing);
  const revoke = options.pairing.revokeNativeContinuation.bind(options.pairing);
  const scopes = options.scopes.grantedScopes.bind(options.scopes), seamFor = options.seam;
  const leader = options.isPaymentsLeader, config = options.config, replies = options.replies;
  const router = daemonNoticeRouter(options.router), catalog = options.catalog, ownerInbox = options.ownerInbox;
  return async (request, owner) => {
    const readHistory = owner.readReplyHistory?.bind(owner);
    await waitForGatewayScopePolicyBootstrap(catalog, owner.signal); owner.assertCurrent();
    const grant = request.host.continuation, checkpoint = request.window;
    const kind = checkpoint?.record.windowKind, notice = checkpoint?.record.windowNotice;
    const seam = seamFor(), restore = seam?.restoreCheckoutRecovery?.bind(seam), capture = seam?.capturePageConnection?.bind(seam);
    if (!grant || !checkpoint || !kind || notice === undefined || !seam || !restore || !capture || !request.host.browser || !request.host.browserControls) throw new CheckoutOwnershipError();
    const facts = captureBrowserCheckoutRecovery({ connection: request.host.browser, controls: request.host.browserControls });
    const expected = request.host.authority;
    const authorityCurrent = () => {
      owner.signal.throwIfAborted(); owner.assertCurrent();
      const issued = read(grant), available = scopes();
      if (seamFor() !== seam || !leader() || !readPaymentsEnabled(config) || !issued
        || !isDeepStrictEqual(issued, expected)
        || !isDeepStrictEqual(captureOwnedJson(readPaymentsServiceConfig(config)), request.host.configuration)
        || !expected.scopes.includes('*') && missingScopes(available, expected.scopes).length > 0) throw new CheckoutOwnershipError();
      owner.signal.throwIfAborted();
    };
    // The pairing writer is held for short admission only, never a browser
    // connection or a payment window lasting minutes. Every later effect
    // checks the actual original issuer again through authorityCurrent.
    await withGrant(grant, expected, assertIssued => { assertIssued(); authorityCurrent(); }); authorityCurrent();
    let page: (RestoredCheckoutPage & { readonly driver: import('../checkout-page.js').CheckoutPageDriver }) | undefined;
    try {
      page = await restore(facts, { signal: owner.signal, assertCurrent: authorityCurrent }); authorityCurrent(); page.assertCurrent();
      const retainedPage = page;
      const current = () => { authorityCurrent(); retainedPage.assertCurrent(); };
      const input = Object.freeze({ ...request.input, sessionId: retainedPage.sessionId, pageId: retainedPage.pageId, reading: checkpoint.reading });
      const source = Object.freeze({ principalId: request.principalId, assertCurrent: current,
        taintEvidence: request.evidence, recoveryFacts: { authority: expected, configuration: request.host.configuration },
        revokeContinuation: revoke,
        captureBrowserRecovery: async (_input: typeof input, checkpointOwner: import('./checkout-operations.js').DetachedCheckoutOwner) => {
          current(); checkpointOwner.assertCurrent(); retainedPage.assertControlsCurrent();
          const connection = await capture(retainedPage.sessionId, retainedPage.pageId,
            { signal: checkpointOwner.signal, assertCurrent: () => { current(); checkpointOwner.assertCurrent(); retainedPage.assertControlsCurrent(); } });
          current(); checkpointOwner.assertCurrent(); retainedPage.assertControlsCurrent();
          if (!isDeepStrictEqual(connection, facts.connection)) throw new CheckoutOwnershipError();
          // These saved control facts remain usable only under the real page,
          // native connection and original snapshot guards above. They are not
          // rebranded as a freshly observed native snapshot.
          return captureBrowserCheckoutRecovery({ connection, controls: facts.controls });
        },
      });
      return Object.freeze({ source, input, driver: retainedPage.driver, release: retainedPage.release.bind(retainedPage),
        resumption: Object.freeze({ checkpoint, prepare: (windowOwner: import('../checkout-ownership.js').CheckoutOperationOwnership & { readonly keepOnStop?: (() => boolean) | undefined }) => {
          current(); windowOwner.assertCurrent?.();
          if (!windowOwner.signal) throw new CheckoutOwnershipError();
          const retiredWindow = new AbortController(), signal = AbortSignal.any([windowOwner.signal, retiredWindow.signal]);
          const windowCurrent = () => { signal.throwIfAborted(); current(); windowOwner.assertCurrent?.(); };
          const delivered = checkpoint.record.windowDeliveries?.filter(delivery => delivery.delivered) ?? [];
          // The owner-inbox delivery is read back from the inbox's own store; every other one is a Telegram recipient.
          const inboxDelivery = delivered.find(delivery => delivery.channel === 'owner-inbox');
          if (inboxDelivery && !ownerInbox) throw new PaymentReplyWindowError('source-unavailable');
          // The same order the boot sweep states: only a window whose every
          // delivered channel keeps its replies across a restart resumes.
          // Reopen uncovered delivered recipients only, at the exact acknowledged
          // recipient/account/topic. Never replace them with configured defaults
          // or treat a backfillable flag as proof that history was recovered.
          const rule = recoverInterruptedWindow({ deliveries: delivered, deadlinePassed: Date.now() > (checkpoint.record.windowDeadlineMs ?? 0) });
          if (rule.outcome !== 'resume') throw new PaymentReplyWindowError('source-unavailable');
          const targets: PaymentNoticeTarget[] = [];
          const telegramDelivered = delivered.filter(delivery => delivery.channel !== 'owner-inbox');
          const receipts = telegramDelivered.map(delivery => {
            const receipt = capturePaymentNoticeReceipt(delivery.receipt, 'telegram');
            if (!receipt?.accountId || !telegramNumber(receipt.conversationId, true) || !telegramNumber(receipt.messageId)
              || receipt.threadId !== undefined && !telegramNumber(receipt.threadId)) throw new PaymentReplyWindowError('source-unavailable');
            const binding: ChannelDeliveryRouteBinding = { id: `payment-recovery:${request.purchaseId}`, surfaceKind: 'telegram',
              surfaceId: receipt.conversationId, externalId: receipt.conversationId, channelId: receipt.conversationId,
              ...(receipt.threadId ? { threadId: receipt.threadId } : {}), metadata: {} };
            targets.push({ channel: 'telegram', request: { target: { kind: 'surface', surfaceKind: 'telegram', address: receipt.conversationId }, binding, allowDuplicate: true }, backfillable: false });
            return receipt;
          });
          const restored = prepareRestoredPaymentReplyWindow({ purchaseId: request.purchaseId, checkpoint,
            recipients: receipts.map((receipt, index) => {
              const delivery = telegramDelivered[index], target = targets[index];
              if (!delivery || !target) throw new CheckoutOwnershipError();
              return { receipt, delivery, target };
            }), readHistory, replies, router, signal, assertCurrent: windowCurrent,
            renewMinutes: kind === 'approval' ? request.host.configuration.approvalMinutes : request.host.configuration.vetoMinutes,
            ...(windowOwner.keepOnStop ? { keepOnStop: windowOwner.keepOnStop } : {}),
            ...(inboxDelivery && ownerInbox ? { inbox: { port: ownerInbox, key: purchaseInboxKey(request.purchaseId, kind), delivery: inboxDelivery } } : {}) });
          return Object.freeze({ ...restored, cancel: () => { retiredWindow.abort(); restored.cancel(); } });
        } }),
      });
    } catch (error) { await page?.release(); throw error; }
  };
}
