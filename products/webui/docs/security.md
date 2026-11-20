# Security notes

GoodVibes WebUI is a local/operator surface over a daemon. It should keep
security ownership with the daemon and avoid creating duplicate secret or auth
stores in browser code.

## Trust boundary

- The daemon/control-plane API is the authority for auth, config, providers,
  chat, artifacts, and Knowledge/Wiki.
- WebUI is a browser client. It may cache UI preferences and recent chat ids, but
  it should not become a durable source of truth for daemon state.
- Binding WebUI to `0.0.0.0` exposes the Vite/WebUI surface to the local network.
  Use local firewall policy to restrict traffic to trusted LAN clients.

## Auth

- On the direct route (the page talks to the daemon's own origin) every sign-in
  (a username and password, a pasted or scanned code or token, a `#pair=` link)
  is one `POST /api/browser-session`: the daemon checks what was presented and
  binds it to an HttpOnly, SameSite=Strict cookie (Secure over TLS) that no page
  script can read. The credential never comes back to the page; the page reads
  only the marker beside it (`goodvibes_identity`: a fresh generation and who is
  signed in), which is how every tab notices a sign-in or sign-out. A refused
  code changes nothing.
- A request that authenticates by that cookie is held to the page's origin: a
  state-changing one must carry the daemon's own Origin (or one listed in
  `controlPlane.cors.allowedOrigins`), and a read, the event stream included, is
  refused when it names another origin. A page on another port of the same host
  carries the cookie but cannot use it.
- On the relay route the relay tunnel builds every request in the page, so the
  bearer is held in memory only, for the life of the page, and the relay
  pairing likewise; a reload asks for the relay code and a sign-in again.
- Signing out ends the daemon session (`POST /logout`) and clears the cookie
  and the marker.
- A pairing link's one-time token is captured and stripped from the URL
  immediately, so it never lingers in the address bar or a history entry, and
  the QR scanner never renders or logs the secret it carried.
- Nothing token-shaped is written to localStorage, sessionStorage or IndexedDB
  by any sign-in path. The service worker never caches an API response or any
  response the daemon marks `no-store` or `private`.

Browser code must not read or scrape:

- `~/.goodvibes/tui/auth-users.json`
- `~/.goodvibes/tui/auth-bootstrap.txt`
- `operator-tokens.json`
- other daemon/TUI private auth files

GoodVibes secret refs such as `goodvibes://secrets/...` are daemon-side
credential resolution for downstream services. They are not WebUI auth tokens.

## Relay and step-up

A relay pairing held for the page lets the app tunnel calls through a rendezvous relay
when the daemon is unreachable directly. The tunnel is end to end encrypted
against the daemon's public key from the pairing, and the pairing itself
carries no identity, so holding it signs nobody in. The daemon gates
state-changing relay calls behind a WebAuthn step-up assertion, judged by the
operator method each call reaches rather than its HTTP verb; a state-changing
call without a fresh assertion is refused, the passkey ceremony runs, and the
call retries once. When the daemon has no passkey it could accept, no dialog
opens: the refusal says to register one while connected directly to the
daemon. A cancelled or unavailable ceremony surfaces the refusal instead of
skipping verification.

## Web Push

Push key custody is daemon-side. The VAPID private key never leaves the daemon,
and the browser fetches only the public key (`push.vapid.get`) to subscribe.
Push subscriptions are stored by the daemon (`push.subscriptions.*`). Push and
install require a secure (HTTPS) context; the app states this on plain HTTP
instead of failing silently.

## Network

Development topology:

- WebUI/Vite: `3423`
- Daemon/control-plane: `3421`
- HTTP listener/webhook surface: `3422`

The browser should normally use the WebUI origin and Vite proxy. The dev proxy
should connect to `127.0.0.1:3421` even when the daemon binds to `0.0.0.0`.
`0.0.0.0` is a bind address, not a client URL.

Do not expose the dev server directly to untrusted networks. A production
deployment should add explicit TLS, host allow-listing, and daemon auth policy.

## Attachments and artifacts

Chat attachments are uploaded to daemon artifacts before being referenced from a
chat message. The browser sends file bytes to the daemon as base64 through the
published platform helper. Operators should avoid attaching secrets unless they intend
the daemon and selected model route to process them.

## Logging and screenshots

- Do not log raw tokens, passwords, or bootstrap credentials.
- Avoid committing screenshots that show private chat content, local secrets,
  provider keys, or sensitive Knowledge records.
- Documentation screenshots should use empty or non-sensitive states.

## Dependency and platform safety

- In this monorepo WebUI resolves `@goodvibes-jev/engine` through the workspace
  link to `packages/engine`, so it always runs against the local engine source.
- Verify the engine version with:

```bash
node -p "require('./node_modules/@goodvibes-jev/engine/package.json').version"
```

## Security issue checklist

When investigating a security-relevant bug, capture:

- WebUI version
- installed engine version
- daemon `/status` version
- route or platform helper used
- request payload shape without secrets
- response status and error code
- whether the issue occurs through same-origin proxy, direct backend URL, or both
