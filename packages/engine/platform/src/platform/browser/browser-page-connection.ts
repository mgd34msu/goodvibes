/** Native browser connection/document observations for host-owned recovery.
 * A parsed record is not an attachment capability, a control reference or
 * permission to resume a purchase. Never publish its private endpoint in UI. */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { debuggerWebSocket } from './browser-cdp.js';
import { readRemotePageConnection } from './browser-host-client.js';
import { captureBrowserPageConnection, BrowserPageConnectionError, type BrowserPageConnection } from './browser-page-connection-data.js';
export { BrowserPageConnectionError, type BrowserPageConnection } from './browser-page-connection-data.js';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Project only native identifiers. Page title, URLs, text and form values
 * returned alongside them by CDP must not enter this retained record. */
function connection(endpoint: string, value: unknown): BrowserPageConnection {
  const raw = captureOwnedJson(value);
  if (!debuggerWebSocket(endpoint) || !object(raw) || !object(raw['target']) || !object(raw['documents'])) throw new BrowserPageConnectionError();
  const target = raw['target']['targetInfo'], tree = raw['documents']['frameTree'];
  if (!object(target) || target['type'] !== 'page' || !id(target['targetId'])
    || target['browserContextId'] !== undefined && !id(target['browserContextId']) || !object(tree)) throw new BrowserPageConnectionError();
  const frames: Array<BrowserPageConnection['frames'][number]> = [];
  const seen = new Set<string>();
  const pending: Array<{ readonly node: unknown; readonly parentId: string | null }> = [{ node: tree, parentId: null }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || !object(entry.node) || !object(entry.node['frame'])) throw new BrowserPageConnectionError();
    const node = entry.node, frame = node['frame'];
    if (!object(frame) || !id(frame['id']) || !id(frame['loaderId']) || seen.has(frame['id']) || seen.size >= 4096
      || frame['parentId'] !== undefined && frame['parentId'] !== entry.parentId) throw new BrowserPageConnectionError();
    seen.add(frame['id']);
    frames.push(Object.freeze({ id: frame['id'], loaderId: frame['loaderId'], parentId: entry.parentId }));
    if (node['childFrames'] !== undefined) {
      if (!Array.isArray(node['childFrames']) || node['childFrames'].length + pending.length + seen.size > 4096) throw new BrowserPageConnectionError();
      for (const child of node['childFrames']) pending.push({ node: child, parentId: frame['id'] });
    }
  }
  return captureBrowserPageConnection({ version: 1, endpoint, targetId: target['targetId'],
    browserContextId: typeof target['browserContextId'] === 'string' ? target['browserContextId'] : null,
    frames });
}

/** Read through the actual Page/Context or its private Node-host mapping.
 * The caller owns this complete operation, including CDP detach on failure.
 * Do not race it against a timeout and then release the browser owner. */
export async function observeBrowserPageConnection(context: BrowserContext, page: Page, endpoint: string, current: () => void): Promise<BrowserPageConnection> {
  current();
  if (!debuggerWebSocket(endpoint)) throw new BrowserPageConnectionError();
  try {
    const remote = readRemotePageConnection(page);
    if (remote) {
      const raw = await remote; current();
      const result = connection(endpoint, raw); current(); return result;
    }
    const session = await context.newCDPSession(page);
    let result: BrowserPageConnection;
    try {
      current();
      const target = await session.send('Target.getTargetInfo'); current();
      const documents = await session.send('Page.getFrameTree'); current();
      result = connection(endpoint, { target, documents }); current();
    } finally { await session.detach(); }
    current(); return result;
  } catch {
    throw new BrowserPageConnectionError();
  }
}

/** Select by native target/context and original document observations. The
 * caller already connected to the retained exact browser WebSocket. Never
 * choose a tab by URL, index or display title, and never create a substitute. */
export async function findOriginalBrowserPage(browser: Browser, source: BrowserPageConnection, current: () => void): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  current();
  const contexts = [...browser.contexts()];
  let inspected = 0;
  for (const context of contexts) {
    current();
    for (const page of [...context.pages()]) {
      current();
      if (++inspected > 4096) throw new BrowserPageConnectionError();
      let observed: BrowserPageConnection;
      try { observed = await observeBrowserPageConnection(context, page, source.endpoint, current); }
      catch { current(); continue; }
      current();
      if (observed.targetId !== source.targetId) continue;
      if (!isDeepStrictEqual(observed, source)) throw new BrowserPageConnectionError();
      return { context, page };
    }
  }
  throw new BrowserPageConnectionError();
}
