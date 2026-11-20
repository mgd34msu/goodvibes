import { assertSameOriginAbsoluteUrl } from './paths.js';
import { openRawServerSentEventStream, type ServerSentEventHandlers, type ServerSentEventStreamHandle, type ServerSentEventOptions as CoreServerSentEventOptions } from './sse-stream.js';
import type { HttpTransport } from './http.js';

export type { ServerSentEventHandlers, ServerSentEventStreamHandle };
export interface ServerSentEventOptions extends Omit<CoreServerSentEventOptions, 'authToken'> {}

export async function openServerSentEventStream(
  transport: HttpTransport,
  pathOrUrl: string,
  handlers: ServerSentEventHandlers,
  options: ServerSentEventOptions = {},
): Promise<ServerSentEventStreamHandle> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? assertSameOriginAbsoluteUrl(pathOrUrl, transport.buildUrl('/'))
    : transport.buildUrl(pathOrUrl);
  // Through the transport's headers and middleware, as every JSON call goes.
  return await openRawServerSentEventStream(transport.streamFetch, url, handlers, {
    ...options,
    authToken: transport.authToken,
    getAuthToken: transport.getAuthToken.bind(transport),
  });
}
