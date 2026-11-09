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
import { requireDecisionFeature } from '../../runtime/decision-policy.js';
import { captureBrowserCheckoutRecovery } from '../../browser/browser-checkout-recovery-data.js';
import type { RestoredCheckoutPage } from '../../browser/browser-engine.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { readPaymentsEnabled, readPaymentsServiceConfig, type PaymentsConfigReader } from '../payments-config.js';
import { createChannelPaymentNotifier, readPaymentReply, type PaymentNoticeTarget } from '../notice-delivery.js';
import { capturePaymentReplyHistory, type PaymentReplyHistory } from '../reply-history.js';
import { capturePaymentNoticeReceipt } from '../notice-receipt.js';
import { PaymentReplyWindowError, type PaymentReplyInbox } from '../reply-inbox.js';
import { daemonNoticeRouter } from './notifier.js';
import type { CheckoutComposition } from './checkout-handlers.js';

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
}

export function createNativeCheckoutWindowRestorer(options: NativeCheckoutWindowRestorationOptions): NonNullable<CheckoutComposition['restoreWindow']> {
  const read = options.pairing.readNativeContinuation.bind(options.pairing);
  const withGrant = options.pairing.withNativeContinuation.bind(options.pairing);
  const revoke = options.pairing.revokeNativeContinuation.bind(options.pairing);
  const scopes = options.scopes.grantedScopes.bind(options.scopes), seamFor = options.seam;
  const leader = options.isPaymentsLeader, config = options.config, replies = options.replies;
  const router = daemonNoticeRouter(options.router), catalog = options.catalog;
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
      requireDecisionFeature('resuming an original automated checkout window');
      const issued = read(grant), available = scopes();
      if (seamFor() !== seam || !leader() || !readPaymentsEnabled(config) || !issued
        || !isDeepStrictEqual(issued, expected)
        || !isDeepStrictEqual(captureOwnedJson(readPaymentsServiceConfig(config)), request.host.configuration)
        || !expected.scopes.includes('*') && expected.scopes.some(scope => !available.includes(scope))) throw new CheckoutOwnershipError();
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
        resumption: Object.freeze({ checkpoint, prepare: (windowOwner: import('../checkout-ownership.js').CheckoutOperationOwnership) => {
          current(); windowOwner.assertCurrent?.();
          if (!windowOwner.signal) throw new CheckoutOwnershipError();
          const retiredWindow = new AbortController(), signal = AbortSignal.any([windowOwner.signal, retiredWindow.signal]);
          const windowCurrent = () => { signal.throwIfAborted(); current(); windowOwner.assertCurrent?.(); };
          const delivered = checkpoint.record.windowDeliveries?.filter(delivery => delivery.delivered) ?? [];
          // The current native router has no durable history capability.
          // Reopen uncovered delivered channels only, at the exact acknowledged
          // recipient/account/topic. Never replace them with configured defaults
          // or treat a backfillable flag as proof that history was recovered.
          if (!delivered.length || delivered.some(delivery => delivery.backfillable || delivery.channel !== 'telegram')) throw new PaymentReplyWindowError('source-unavailable');
          const targets: PaymentNoticeTarget[] = [];
          const receipts = delivered.map(delivery => {
            const receipt = capturePaymentNoticeReceipt(delivery.receipt, 'telegram');
            if (!receipt?.accountId || !telegramNumber(receipt.conversationId, true) || !telegramNumber(receipt.messageId)
              || receipt.threadId !== undefined && !telegramNumber(receipt.threadId)) throw new PaymentReplyWindowError('source-unavailable');
            const binding: ChannelDeliveryRouteBinding = { id: `payment-recovery:${request.purchaseId}`, surfaceKind: 'telegram',
              surfaceId: receipt.conversationId, externalId: receipt.conversationId, channelId: receipt.conversationId,
              ...(receipt.threadId ? { threadId: receipt.threadId } : {}), metadata: {} };
            targets.push({ channel: 'telegram', request: { target: { kind: 'surface', surfaceKind: 'telegram', address: receipt.conversationId }, binding, allowDuplicate: true }, backfillable: false });
            return receipt;
          });
          const notifier = createChannelPaymentNotifier({ requireDeliveryReceipt: true, router, targets, replies });
          let reception: import('../payment-ports.js').PaymentNoticeWindow | undefined, retired = false;
          let historicalRefusal: 'deny' | 'object' | undefined;
          const ready = (async () => {
            const pending = await Promise.allSettled(receipts.map(receipt => replies.retainTelegramReceipt(receipt, { signal, assertCurrent: windowCurrent })));
            const accounts: { assertCurrent(): void }[] = [];
            for (const result of pending) {
              if (result.status === 'rejected') throw new PaymentReplyWindowError('source-unavailable');
              accounts.push(result.value);
            }
            windowCurrent(); if (retired) throw new CheckoutOwnershipError();
            const originalSources = () => { windowCurrent(); for (const account of accounts) account.assertCurrent(); };
            let retainedHistory: PaymentReplyHistory | undefined;
            try { retainedHistory = await readHistory?.(); }
            catch { throw new PaymentReplyWindowError('history-unavailable'); }
            originalSources();
            if (retainedHistory) {
              let history: PaymentReplyHistory;
              try { history = capturePaymentReplyHistory(retainedHistory, checkpoint); }
              catch { throw new PaymentReplyWindowError('history-unavailable'); }
              const originalWindow = history.windows.at(-1); if (!originalWindow) throw new PaymentReplyWindowError('source-unavailable');
              for (const entry of [...originalWindow.entries].sort((a, b) => a.sentAtMs - b.sentAtMs || Number(a.messageId) - Number(b.messageId) || Number(a.updateId) - Number(b.updateId))) {
                if (entry.sentAtMs >= originalWindow.binding.deadlineMs) continue;
                const answer = await readPaymentReply(entry.text, kind, notice, signal, originalSources); originalSources();
                // A saved objection is enough to stop a purchase. Positive
                // answers and silence still need complete receive coverage;
                // a stored list alone cannot prove an earlier reply is absent.
                if (answer === 'deny' || answer === 'object') {
                  historicalRefusal = answer; return checkpoint.record.windowDeliveries ?? [];
                }
              }
            }
            reception = notifier.prepareWindow?.({ purchaseId: request.purchaseId, kind, notice,
              signal, assertCurrent: originalSources });
            if (!reception) throw new CheckoutOwnershipError();
            const report = await reception.deliveries; originalSources();
            if (retired || report.length !== receipts.length || report.some((delivery, index) => {
              const expectedReceipt = receipts[index], actual = delivery.receipt;
              return !delivery.delivered || !expectedReceipt || !actual || actual.accountId !== expectedReceipt.accountId
                || actual.conversationId !== expectedReceipt.conversationId || actual.threadId !== expectedReceipt.threadId
                || !telegramNumber(actual.messageId) || Number(actual.messageId) <= Number(expectedReceipt.messageId);
            })) throw new PaymentReplyWindowError('source-unavailable');
            return report;
          })();
          const deliveries = ready.catch(error => { reception?.cancel(); throw error; }); void deliveries.catch(() => {});
          const deadlineMs = deliveries.then(() => {
            windowCurrent();
            if (historicalRefusal) return checkpoint.record.windowDeadlineMs ?? Number.NaN;
            return Date.now() + (kind === 'approval' ? request.host.configuration.approvalMinutes : request.host.configuration.vetoMinutes) * 60_000;
          }); void deadlineMs.catch(() => {});
          return Object.freeze({ deliveries, deadlineMs, cancel: () => { retired = true; retiredWindow.abort(); reception?.cancel(); },
            awaitAnswer: (deadline: number) => { windowCurrent(); if (retired) throw new CheckoutOwnershipError();
              if (historicalRefusal) return Promise.resolve({ answer: historicalRefusal, channel: 'telegram' as const });
              if (!reception) throw new CheckoutOwnershipError(); return reception.awaitAnswer(deadline); } });
        } }),
      });
    } catch (error) { await page?.release(); throw error; }
  };
}
