/**
 * The machine half of the Google connector.
 *
 * Everything else in this module is policy over injected ports, so the whole
 * connector, consent, token refresh, the Gmail and Calendar calls, the setup
 * flows, the console walkthrough, runs in a test with no filesystem, no
 * socket, no subprocess and no browser. That property is only worth anything
 * if the concrete implementations live somewhere separate, and this is that
 * somewhere: four small adapters, each the ONLY place its kind of I/O happens.
 *
 *   - `nodeGoogleFilePort`      reads files (never writes: adoption reads
 *                               another tool's credentials and must not touch
 *                               them)
 *   - `createProcessCommandPort` spawns subprocesses, for the gcloud driver,
 *                               and downloads its archive with progress
 *   - `startLoopbackListener`   binds the loopback port Google redirects to
 *   - `createFetchCalDavHttpPort` performs CalDAV HTTP
 *
 * This entry is deliberately NOT re-exported from the module index: importing
 * the connector must never drag a runtime-specific implementation in behind
 * it. A consumer asks for these by name, from here.
 */

import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { GoogleFilePort } from './credential-adoption.js';
import type { GoogleCommandPort } from './types.js';
import { GCLOUD_DEFAULT_TIMEOUT_MS } from './gcloud.js';
import { runProcess } from '../utils/process-runner.js';
import {
  classifyLoopbackRedirect,
  renderLoopbackOutcomePage,
  renderLoopbackPendingPage,
  type LoopbackCodeResult,
  type LoopbackPageOutcome,
  type LoopbackListener,
  type StartLoopbackListenerOptions,
} from './oauth-loopback.js';
import { CALDAV_BODY_TOO_LARGE_ERROR, type CalDavHttpPort, type CalDavHttpRequest, type CalDavHttpResponse } from './caldav-client.js';

/** Plain node file reads. Adoption never writes, so there is no write side. */
export const nodeGoogleFilePort: GoogleFilePort = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * The real command port. gcloud and its installer are shell launchers that
 * start Python as a child, so the shared runner owns the command: it starts in
 * its own process group, the whole group is stopped at the timeout, and the
 * call returns at the timeout with the output read so far instead of waiting
 * for a grandchild that still holds the pipes.
 */
export function createProcessCommandPort(signal?: AbortSignal): GoogleCommandPort {
  // `signal`: a run the person stopped (google.stop) ends the command under way and starts no other.
  return {
    async run(command, args, options) {
      try {
        const result = await runProcess({
          args: [command, ...args],
          timeoutMs: options?.timeoutMs ?? GCLOUD_DEFAULT_TIMEOUT_MS,
          ...(options?.env ? { env: { ...options.env } } : {}),
          ...(signal ? { signal } : {}),
        });
        return {
          code: result.timedOut ? null : result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          spawnError: null,
        };
      } catch (error) {
        return {
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // The SDK archive, streamed to its file so each piece that arrives can be said (curl holds its
    // progress back when its output is a pipe). An HTTP error is a failure, never saved as the file.
    async download(url, path, onProgress) {
      try {
        const response = await fetch(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
        if (!response.ok || !response.body) return { ok: false, problem: `Downloading ${url} failed: HTTP ${response.status}.` };
        const length = Number(response.headers.get('content-length'));
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        const out = createWriteStream(path);
        let received = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (!out.write(value)) await once(out, 'drain');
            onProgress(received, total);
          }
        } finally {
          reader.releaseLock();
          out.end();
          await once(out, 'close');
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, problem: `Downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

/**
 * Starts the local HTTP listener the browser redirects back to. Resolves as
 * soon as the server is bound; the first well-formed redirect it receives
 * settles `waitForCode()`, later redirects to the same server are ignored.
 *
 * The decision about what a given redirect means, is it ours, does it carry a
 * code, did Google report an error, is `classifyLoopbackRedirect`, not
 * anything here, so the `state` check that defends this flow is exercised by
 * tests that never bind a port.
 */
/** Longest the tab that delivered the code waits for the exchange and save before it is told to return to the app. */
const PAGE_ANSWER_WAIT_MS = 60_000;
/** How long the answered page is given to be written before the port is released. */
const PAGE_FLUSH_MS = 250;

export function startLoopbackListener(options: StartLoopbackListenerOptions): LoopbackListener {
  const host = options.host ?? '127.0.0.1';
  let settled = false;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCode!: (result: LoopbackCodeResult) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<LoopbackCodeResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler immediately, at creation, so this promise is never
  // reported as an unhandled rejection. `waitForCode` hands back this exact
  // promise (deliberately not a Promise.race derivative, a promise created
  // by racing does not inherit this early handler, and Bun.serve treats an
  // unhandled rejection surfacing during request handling as a fatal error) so
  // callers still observe the real resolution or rejection.
  codePromise.catch(() => undefined);

  function settle(action: () => void): void {
    if (settled) return;
    settled = true;
    if (activeTimer) clearTimeout(activeTimer);
    action();
  }

  const html = (status: number, body: string): Response => new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  // The tab that delivered the code waits for the exchange and save: it is
  // told "connected" only once the credential is stored.
  let answerPage: ((outcome: LoopbackPageOutcome) => void) | undefined;
  let answering: Promise<Response> | undefined;
  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    fetch(request: Request): Response | Promise<Response> {
      const outcome = classifyLoopbackRedirect(request.url, options.expectedState);
      if (outcome.kind === 'error') {
        // A stray hit (a probe, a prefetch, another page) must not end a
        // consent the person is still completing: only an error that carries
        // this run's state is Google's answer.
        if (outcome.settlesWait) settle(() => rejectCode(outcome.error));
        return html(outcome.status, outcome.body);
      }
      if (settled) return html(409, renderLoopbackPendingPage());
      answering = new Promise<Response>((resolveAnswer) => {
        const deadline = setTimeout(() => { answerPage = undefined; resolveAnswer(html(202, renderLoopbackPendingPage())); }, PAGE_ANSWER_WAIT_MS);
        answerPage = (page) => {
          answerPage = undefined;
          clearTimeout(deadline);
          const rendered = renderLoopbackOutcomePage(page);
          resolveAnswer(html(rendered.status, rendered.body));
        };
      });
      const respond = (page: LoopbackPageOutcome): void => { answerPage?.(page); };
      settle(() => resolveCode({ ...outcome.result, respond }));
      return answering;
    },
  });

  const redirectUri = `http://${host}:${server.port}/`;

  return {
    redirectUri,
    waitForCode(timeoutMs: number): Promise<LoopbackCodeResult> {
      if (settled) return codePromise;
      activeTimer = setTimeout(() => {
        settle(() => rejectCode(new Error('Timed out waiting for the browser redirect.')));
      }, timeoutMs);
      return codePromise;
    },
    close(): void {
      // Settle first: a wait that is still pending must end, or whoever
      // awaits it is suspended for ever once the server is gone.
      settle(() => rejectCode(new Error('The sign-in listener was closed before a redirect arrived.')));
      // A tab still waiting for its page is told the consent stopped.
      answerPage?.({ ok: false, message: 'The connection stopped before it finished. Return to the app and try again.' });
      if (answering === undefined) { server.stop(true); return; }
      // Let the page that was just answered be written, then release the port.
      void answering.then(() => setTimeout(() => { server.stop(true); }, PAGE_FLUSH_MS));
    },
  };
}

/** Longest a CalDAV request may take before it is abandoned. */
export const CALDAV_REQUEST_TIMEOUT_MS = 30_000;
/** Largest CalDAV response body the port will buffer. */
export const CALDAV_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface FetchCalDavHttpPortOptions {
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      const error = new Error(`the response is larger than ${maxBytes} bytes`);
      error.name = CALDAV_BODY_TOO_LARGE_ERROR;
      throw error;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Most same-origin redirects the port follows for one request. */
const CALDAV_MAX_SAME_ORIGIN_REDIRECTS = 5;
const CALDAV_REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * The only place the CalDAV client performs real network I/O: a thin wrapper
 * over the global `fetch`. A server that stops answering ends in a thrown
 * error (which the client reports as "could not reach the calendar server")
 * instead of holding the calling tool open.
 *
 * Redirects are never followed by the runtime. A redirect within the origin
 * the caller addressed (a trailing-slash fix, a moved path) is followed here
 * with the same method, headers and body, since nothing leaves the server the
 * caller chose. A redirect to any other origin is handed back as the 3xx with
 * an absolute `location` header, so the caller's credential rule decides it
 * and no request body reaches that host first.
 */
export function createFetchCalDavHttpPort(options: FetchCalDavHttpPortOptions = {}): CalDavHttpPort {
  const timeoutMs = options.timeoutMs ?? CALDAV_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? CALDAV_MAX_BODY_BYTES;
  return {
    async request(input: CalDavHttpRequest): Promise<CalDavHttpResponse> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let url = input.url;
      for (let hop = 0; ; hop += 1) {
        const response = await fetch(url, {
          method: input.method,
          headers: input.headers as Record<string, string>,
          signal,
          redirect: 'manual',
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const location = CALDAV_REDIRECT_STATUSES.has(response.status) ? headers['location'] : undefined;
        if (location !== undefined) {
          let next: URL | null = null;
          try {
            next = new URL(location, url);
          } catch {
            next = null;
          }
          if (next !== null) {
            headers['location'] = next.toString();
            if (next.origin === new URL(url).origin && hop < CALDAV_MAX_SAME_ORIGIN_REDIRECTS) {
              await response.body?.cancel().catch(() => undefined);
              url = next.toString();
              continue;
            }
          }
        }
        const body = await readCappedText(response, maxBodyBytes);
        return { status: response.status, headers, body, url };
      }
    },
  };
}
