/** Consumer-vantage pin for the host-only intake public package subpath. */
import { InboxCursorStore, InboundPoller, type AdapterContext, type InboundChannelItem, type InboxQuery, type IntakeCredentialStore, type ProviderPollOptions } from '@goodvibes-jev/engine/platform/platform/intake';

declare const credentials: IntakeCredentialStore;
declare const context: AdapterContext;
declare const item: InboundChannelItem;
declare const query: InboxQuery;
declare const store: InboxCursorStore;
const reader: (ref: string) => Promise<string | null> = credentials.resolveRef;
const reads: AdapterContext['credentials'] = context.credentials;
const rows: InboundChannelItem[] = store.listItems(query);
const count: Promise<number> = store.commitTimestampPoll('fixture', [item], () => {});
const closed: Promise<void> = store.close();
// @ts-expect-error, inbound adapters receive no credential-write capability.
credentials.put('fixture', 'fixture');
export { reader, reads, rows, count, closed };

declare const poller: InboundPoller;
const stopped: Promise<void> = poller.stop();
const providerStopped: Promise<void> = poller.stopProvider('fixture');
const synchronousStart: void = poller.start();
const synchronousProviderStart: void = poller.startProvider('fixture');
declare const cancellationSignal: NonNullable<ProviderPollOptions['signal']>;
const pollOptions: ProviderPollOptions = { limit: 10, signal: cancellationSignal };
export { stopped, providerStopped, synchronousStart, synchronousProviderStart, pollOptions };

const legacyStop: () => void = () => { void poller.stop(); };
export { legacyStop };
