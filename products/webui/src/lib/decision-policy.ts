import { BrowserDecisionPolicy } from '@goodvibes-jev/engine/platform/browser/decision-policy';
import { subscribeClientLifetime } from './client-lifetime';

/** Observation only; the daemon independently owns execution policy. */
export const browserDecisionPolicy = new BrowserDecisionPolicy();
subscribeClientLifetime(() => browserDecisionPolicy.reset());
