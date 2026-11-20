/*
 * GoodVibes operator shell, service worker.
 *
 * TWO JOBS, and a hard line between them:
 *
 *  1. Cache the APP SHELL (the HTML document + the hashed JS/CSS/icons Vite
 *     emits) so the installed app opens even with no network. A page load
 *     prefers the daemon's current shell and falls back to the cached one
 *     after a short wait, so an upgrade never runs a stale shell.
 *
 *  2. Receive Web Push notifications (approvals / completions the daemon fans
 *     out) and deep-link a tap into the right view.
 *
 * THE HONESTY LINE, this is the whole point, do not cross it:
 *   The daemon is the single source of truth for every piece of live data
 *   (sessions, approvals, config, auth, memory, ...). The service worker
 *   NEVER caches an API response. `/api/*`, `/login`, `/logout`, `/status`,
 *   `/task`, `/config`, and every event-stream go straight to the network with
 *   no fallback, and no response the daemon marks `no-store` or `private` (every
 *   answer that carries or depends on a sign-in) is ever written to a cache. So when the app opens offline (or the daemon is unreachable),
 *   the SHELL loads from cache but every data call fails, and the app shows
 *   its existing "Can't reach the daemon" state (DaemonUnreachableGate). The
 *   offline app reads as an honest degraded state, never as stale-live data.
 *   A service worker that answered an API call from cache would be showing a
 *   confident number that might be hours old: that is the trap this avoids.
 *
 * Bump CACHE_VERSION whenever the caching behavior itself changes; `activate`
 * deletes every cache that is not the current version.
 */

const CACHE_VERSION = 'v2';
const SHELL_CACHE = `goodvibes-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `goodvibes-assets-${CACHE_VERSION}`;
/** Every cache name this worker ever creates starts with one of these; activation cleans only those. */
const OWN_CACHE_PREFIXES = ['goodvibes-shell-', 'goodvibes-assets-'];

// The minimal shell precached on install: the document itself and the app
// icons. Hashed JS/CSS chunks are filled in at runtime (cache-first) the first
// time they are fetched, their names are build-generated, so they cannot be
// listed here by hand.
// Hashed assets from older deploys are never evicted by version, so the asset cache
// is capped: past this many entries the oldest-stored ones (earlier builds) go first.
const MAX_ASSET_ENTRIES = 300;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/goodvibes-icon.png'];

// Paths whose responses must NEVER be cached, the daemon owns this data and it
// must always be fetched live or fail honestly. Matched against the pathname.
const NEVER_CACHE_PREFIXES = ['/api/', '/login', '/logout', '/status', '/task', '/config'];

function isNeverCache(url) {
  return NEVER_CACHE_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

// A response the daemon marks as not to be kept (an authenticated answer, a sign-in) is
// never written to a cache, whatever its path.
function mayBeCached(response) {
  const control = (response.headers.get('cache-control') || '').toLowerCase();
  return !/\b(?:no-store|private)\b/.test(control);
}

// Only genuine, immutable build output is cache-first. In a Vite PRODUCTION
// build that is /assets/* (hashed chunks) plus the icons and manifest. This
// deliberately excludes dev-server module paths (/src/*, /@vite/*, /@fs/*) so
// running the SW against the dev server never caches a hot module and breaks
// HMR, those fall through to the network untouched.
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/goodvibes-icon.png' ||
    url.pathname === '/favicon.ico'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      // A missing precache entry must not wedge the whole install (e.g. a dev
      // server that does not serve one of these yet). Best-effort shell fill, but
      // never silent: an incomplete shell cache means a broken offline shell.
      .catch((error) => {
        console.warn('Service worker precache failed; the offline shell may be incomplete:', error);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Only this app's own earlier caches: another app served on the same
            // origin (behind one reverse proxy) keeps its caches.
            .filter((key) => OWN_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Let the page trigger an immediate activation of a waiting worker (the
// install-prompt / update flow posts { type: 'SKIP_WAITING' }).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// How long a page load waits for the daemon's current shell before opening the
// cached one. The shell names this build's hashed chunks: a cached shell from
// before an upgrade names chunks the daemon no longer serves, so a feature
// loaded on demand (QR pairing, wake word) would fail for that whole load.
// A reachable daemon answers well inside this; offline fails at once.
const SHELL_NETWORK_WAIT_MS = 1500;

// Only an HTML document may stand in for the app shell offline: a same-origin
// navigation can also land on a JSON or file response, which must not replace it.
function isHtmlResponse(response) {
  const type = response.headers.get('content-type') || '';
  return type.toLowerCase().includes('text/html');
}

async function networkFirstShell(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && isHtmlResponse(response) && mayBeCached(response)) {
        // waitUntil keeps the worker alive until the write lands; a failed write
        // only costs the next offline open, never this page load.
        event.waitUntil(cache.put('/index.html', response.clone()).catch(() => undefined));
      }
      return response;
    })
    .catch(() => undefined);
  let timer;
  const waited = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), SHELL_NETWORK_WAIT_MS); });
  const first = await Promise.race([network, waited]);
  clearTimeout(timer);
  if (first && first.ok) return first;
  // Offline, slow or failing: the cached shell still opens the app, and a late
  // network copy refreshes the cache for next time (the promise carries its own
  // .catch, so a failed revalidation is never unhandled). With no cache yet,
  // wait for the network; if that also fails, an honest offline page.
  const cached = await cache.match('/index.html', { ignoreSearch: true });
  if (cached) return cached;
  const fresh = first ?? (await network);
  return fresh ?? offlineDocument();
}

function offlineDocument() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>GoodVibes: offline</title>' +
      '<body style="font-family:system-ui,sans-serif;background:#15161b;color:#ececf1;' +
      'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
      '<div><h1 style="font-size:1.1rem">Offline</h1>' +
      '<p style="opacity:.7;max-width:32ch">The app shell has not been cached yet. ' +
      'Reconnect to the daemon once, then it will open offline.</p></div>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_ASSET_ENTRIES;
  for (let i = 0; i < excess; i += 1) await cache.delete(keys[i]);
}

async function cacheFirstAsset(event, request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only cache successful, same-origin, basic responses, never an opaque or
  // error response (which would poison the cache with a broken asset).
  if (response && response.ok && response.type === 'basic' && mayBeCached(response)) {
    event.waitUntil(cache.put(request, response.clone()).then(() => trimAssetCache(cache)).catch(() => undefined));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes always hit the network live.

  const url = new URL(request.url);

  // Cross-origin (e.g. a CDN, or a separately-hosted daemon origin), leave it
  // to the browser's default handling; do not cache another origin's bytes.
  if (url.origin !== self.location.origin) return;

  // The honesty line: daemon-owned data is never cached, never served stale.
  if (isNeverCache(url)) return;

  // Navigation (opening the app / a deep link) → the app shell.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(event, request));
    return;
  }

  // Immutable build assets (hashed, /icons, manifest) → cache-first. Everything
  // else (dev modules, anything unrecognized) falls through to the network.
  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirstAsset(event, request));
  }
});

// ─── Web Push ─────────────────────────────────────────────────────────
//
// The daemon sends a JSON payload shaped like the platform's PushMessage
// ({ title, body, data }). data.kind is 'approval' (with approvalId),
// 'needs-input' or 'completion' (with nodeId and, when known, sessionId); a
// needs-input reminder sent because nobody answered carries escalated: true.
// We render the notification and, on tap, deep-link to the view that action
// lives in.

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'GoodVibes', body: event.data ? event.data.text() : '' };
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'GoodVibes';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  // For an approval, offer Allow/Deny action buttons. Platforms without
  // notification-action support ignore this field and just show the body (a tap
  // still deep-links to the approvals list), an honest graceful degrade. The
  // buttons do NOT approve in the background: notificationclick hands off to the
  // authenticated app, which makes the real call (see docs/push-approval-actions.md).
  const isApproval = data.kind === 'approval' && typeof data.approvalId === 'string' && data.approvalId;
  // needs-input and completion carry no in-notification action, a tap just
  // deep-links to the focused Fleet node. Tag them by node id so repeated pushes
  // about the same node coalesce instead of stacking.
  const hasNode = typeof data.nodeId === 'string' && data.nodeId;
  const tag = typeof data.approvalId === 'string'
    ? `approval-${data.approvalId}`
    : hasNode && data.kind === 'needs-input'
      ? `needs-input-${data.nodeId}`
      : hasNode && data.kind === 'completion'
        ? `completion-${data.nodeId}`
        : undefined;
  // An escalated reminder replaces the earlier notification under the same tag;
  // renotify makes it sound and vibrate again instead of updating silently, and
  // requireInteraction keeps it on screen where the platform supports that.
  const escalated = data.escalated === true && tag !== undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag,
      renotify: escalated ? true : undefined,
      requireInteraction: escalated ? true : undefined,
      actions: isApproval
        ? [
            { action: 'approve', title: 'Allow' },
            { action: 'deny', title: 'Deny' },
          ]
        : undefined,
    }),
  );
});

// Map a notification's data onto an in-app URL. This is the one implementation;
// src/lib/push/sw.test.ts loads and executes this file for every notification
// kind. The `.startsWith('/')` guard is load-bearing: without it an absolute
// `data.url` (e.g. from a malicious or malformed push payload) would have the SW
// open an external site on a notification tap.
function linkForNotification(data, action) {
  // An Allow/Deny action tap carries the choice + approval id back in the FRAGMENT
  // for the authenticated app (the SW holds no operator token): Allow opens that
  // approval for the owner to read and approve, Deny is applied on open (see
  // useApprovalActions and docs/push-approval-actions.md).
  if (
    data &&
    data.kind === 'approval' &&
    typeof data.approvalId === 'string' &&
    data.approvalId.length > 0 &&
    (action === 'approve' || action === 'deny')
  ) {
    return '/?view=approvals-tasks#approval-action=' + action + '&approval-id=' + encodeURIComponent(data.approvalId);
  }
  if (data && data.kind === 'approval') return '/?view=approvals-tasks';
  // needs-input (a fleet node blocked on the operator) and completion (a tracked
  // run that finished): deep-link to the Fleet view focused on that node (carrying
  // its session id when known).
  if (data && (data.kind === 'needs-input' || data.kind === 'completion')) {
    if (typeof data.nodeId === 'string' && data.nodeId.length > 0) {
      var nodePart = 'fleet-node=' + encodeURIComponent(data.nodeId);
      var sessionPart = typeof data.sessionId === 'string' && data.sessionId.length > 0
        ? '&fleet-session=' + encodeURIComponent(data.sessionId)
        : '';
      return '/?view=fleet#' + nodePart + sessionPart;
    }
    return '/?view=fleet';
  }
  if (data && typeof data.url === 'string' && data.url.startsWith('/') && !/^[\\/]{2}|[\\\x00-\x20\x7f]/.test(data.url)) return data.url;
  return '/';
}

// ─── Push subscription self-heal (pushsubscriptionchange) ────────────
//
// The browser fires this when it rotates a push endpoint on its own (a
// certificate/key rollover on the push service, or a browser-side expiry),
// NOT something the app or daemon requested. Per the Push API spec, this can
// fire even while no app tab is open, so the SW is the only code that ever
// sees it.
//
// WHAT THE SW CAN DO ALONE: re-subscribe using event.oldSubscription.options
// (the same userVisibleOnly/applicationServerKey the original subscribe used,
// no cached VAPID key needed) so the browser side never goes dark.
//
// WHAT THE SW CANNOT DO ALONE: tell the daemon about the new endpoint. The
// daemon's push.subscriptions.reconcile call needs the operator's auth token,
// which lives in the page's localStorage, a Service Worker has no access to
// another context's localStorage (it is a separate global scope; there is no
// synchronous cross-context storage API for this). So the SW best-effort
// notifies any ALREADY-OPEN tab via postMessage, which reconciles with its own
// authenticated client. If no tab is open, this rotation is picked up the
// next time the app opens: reconcilePushSubscriptionOnOpen
// (src/lib/push/push-client.ts) compares the live subscription (now the
// rotated one) against the daemon's stale record and heals it then. A rotation
// that happens while the app stays closed for a long stretch is therefore only
// eventually healed, not instantly, an honest limit of what a page-less
// context can authenticate, not a bug to paper over.
//
// A REAL rotation cannot be produced in a headless test browser (there is no
// way to make the OS push service actually rotate a live endpoint), so this is
// exercised as: a unit test drives handlePushSubscriptionChange directly with a
// fake event (src/lib/push/sw.test.ts) proving the re-subscribe + postMessage
// call shape; nothing here verifies an ACTUAL browser-triggered rotation.
async function handlePushSubscriptionChange(event) {
  const oldSubscription = event.oldSubscription;
  const options = oldSubscription && oldSubscription.options
    ? oldSubscription.options
    : { userVisibleOnly: true };
  let subscription;
  try {
    subscription = await self.registration.pushManager.subscribe(options);
  } catch {
    // The browser refused to re-subscribe (e.g. permission was revoked in the
    // interim). Nothing more this handler can do; a future app-open's own
    // subscribe/reconcile flow is the recovery path.
    return;
  }
  const json = subscription.toJSON();
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage({
      type: 'goodvibes-push-subscription-changed',
      endpoint: json.endpoint,
      keys: json.keys,
    });
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(handlePushSubscriptionChange(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = linkForNotification(event.notification.data || {}, event.action);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Prefer focusing an already-open window and navigating it, so a tap does
      // not stack a second copy of the app.
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(target).catch(() => undefined);
          return undefined;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
