# Companion app pairing

## Overview

Pairing is the mechanism by which a companion app (mobile, desktop, browser) establishes a persistent authenticated connection to a running GoodVibes daemon.

The daemon runs locally on a host machine. Companion apps can be on the same machine or on a different device on the same network. Pairing solves the bootstrap problem: how does a companion app get a valid token without requiring the user to type credentials on a small screen?

The answer is a QR code (or a tappable deep link) displayed by the host surface (the TUI, a web UI, or the daemon's own HTTP endpoint). The user scans it, or opens the link, with the companion app or a browser. The code carries a one-time, per-device token as a URL fragment; the device that scans it lands already signed in. The companion app persists that token for all future API calls; a browser opening the web UI hands it to the daemon, which keeps it in an HTTP-only cookie the page cannot read.

There are two token shapes in play, and both authenticate the same way at the network level:

- **Per-device pairing tokens** (current). Every pairing mints its own named,
  individually-revocable token. This is what a fresh scan from Pair something (Devices and network), or a `pairing.handoff.create`
  call, gives you today.
- **The legacy shared token.** One bearer token every companion held before per-device
  pairing existed. It still authenticates until an operator explicitly turns it off, and
  existing installs migrate off it device by device rather than all at once. See
  [Legacy: the shared token](#legacy-the-shared-token) below.

---

## Architecture

### Token-based authentication

GoodVibes companion pairing is built on the same bearer token mechanism documented in [authentication.md](./authentication.md). There is no separate pairing protocol at the network level. The companion app ultimately sends:

```http
Authorization: Bearer <token>
```

on every request, just like any other bearer client, whichever of the two token shapes it holds.

What makes pairing distinct is how that token is provisioned. Instead of a user typing it, the host surface mints it and encodes it into a QR code or deep link.

### Two token shapes

| | Per-device pairing token (current) | Legacy shared token |
| --- | --- | --- |
| Prefix | `gvp_` | `gv_` |
| Scope | One token per paired device, individually named | One token, shared by every companion that has not migrated off it |
| At-rest storage | Only a SHA-256 hash is persisted; the plaintext is returned exactly once, at mint time | The plaintext token itself is persisted |
| Revocation | `pairing.tokens.delete` revokes one device without affecting any other | `pairing.tokens.revokeShared` replaces it: every copy a device holds stops working, and the daemon writes the new value for its own machine's apps |
| Storage location | `<surfaceRoot>/control-plane/pairing-tokens.json` | `<daemonHomeDir>/operator-tokens.json` |

A presented bearer token is checked against per-device pairing tokens first, then the legacy
shared token (after a revocation, only the replacement the daemon wrote), then user sessions. Both a per-device token and the
legacy shared token carry full operator authority, identically to the bootstrap token.

### Persistent tokens

Both token shapes are persistent. Unlike session tokens, they do not expire automatically.
Revocation is always explicit:

- A per-device pairing token is minted once per pairing and stays valid until it is
  individually revoked (`pairing.tokens.delete`). Renaming changes its display
  label without changing its authority.
- The legacy shared token survives daemon restarts and stays valid until an operator calls
  `pairing.tokens.revokeShared`; the older, host-level `regenerateCompanionToken` API also
  replaces it (see [Legacy: the shared token](#legacy-the-shared-token)).
- `pairing.tokens.revokeShared` replaces the shared token rather than leaving the daemon's
  own machine without one: the pairing store records the revocation with the new value's
  hash, the daemon writes that value to `<daemonHomeDir>/operator-tokens.json` and serves
  with it, and the terminal app, the Agent and the daemon CLI on that machine, which read
  the file for every call, stay signed in. Every copy handed to another device stops
  working at once. After that the stored token is never put in a pairing link:
  `goodvibes-daemon pair` mints the device its own token instead (with `-y`). A daemon
  serving a token set by `GOODVIBES_DAEMON_TOKEN` cannot replace it and refuses the call
  (`SHARED_TOKEN_NOT_REPLACEABLE`); change that variable instead. A revocation recorded
  while no daemon was serving is completed when the daemon next starts.

### Storage

**Per-device pairing tokens** live at:

```
<surfaceRoot>/control-plane/pairing-tokens.json
```

under the daemon's home directory. A daemon's `surfaceRoot` is `tui` for historical reasons;
the terminal app, the chat host, and the web app all read the same directory. The file holds only a
SHA-256 hash per token, never the plaintext, plus each token's id, user-visible name, created
timestamp, and last-seen timestamp. It is written at mode `0600`.

When the host issues a native continuation, the private token record also retains
an issued credential-incarnation ID. Its adjacent `.native-owner` file retains
an issued owner ID and the exact original directory ancestry. These IDs are
random references; checking them does not hash the directory or token state.
Back up that file with the pairing store. Missing or damaged continuation-owner
evidence prevents continuation lookup, while ordinary token authentication stays
separate. Copying the files into a different owner directory does not transfer
the authority to continue an earlier operation. Neither file stores the bearer.
Previously issued v1 continuations retain their original read-only verifier.

Issued continuations and cancelled native sources are kept in that file as
revocation records: a consumed or revoked continuation must keep refusing its
source. They are dropped only together with the pairing they were issued under.
When a pairing is revoked, its continuations and the cancelled sources only
they referenced go in the same write; the continuations of a pairing that still
exists are never dropped, and neither is a cancellation no continuation ever
referenced.

If the pairing store cannot be read or written safely, settings changes made
through paired or shared-token authority are refused as `PAIRING_STORE_FAULTED`
(`owner-fault`). A read problem, or a pairing that failed to save, is
re-checked at the next settings capture and clears once the store reads back
cleanly. A failed revoke, rename or grant write is held until the daemon
restarts, so a revocation that did not persist is never treated as undone.

**The legacy shared token** is stored in a single global location under the daemon-home directory:

```
<daemonHomeDir>/operator-tokens.json
```

The canonical default is `~/.goodvibes/daemon/operator-tokens.json`. The file is written at mode `0600` and contains `{ token, peerId, createdAt }` in plaintext. The surface name (`'tui'`, etc.) is retained on the older host-level API for context but does **not** partition this path; all surfaces on a given host share one legacy token.

### Deep-link / QR content

The QR code (or tappable link) encodes the `#pair=<token>` URL fragment, plus an `offers=` key
naming which setup steps the pairing carries (see [Offer set](#offer-set) below):

```
https://app.example.com/#pair=gvp_AbC123...&offers=notifications,relay
```

The token rides in the URL **fragment**, never the query string, so it is never sent to a server:
no access-log entry, no `Referer` header exposure. A camera scan of the QR opens the web app
already carrying the one-time token, so the device lands signed in without any JSON blob to
parse. No producer encodes a raw JSON connection object as the QR content; that shape only
exists in the legacy flow described below.

---

## Pairing flow

### Step 1: Host mints a hand-off

The host surface calls the `pairing.handoff.create` gateway verb (or, for host code composing
the platform directly, `mintPairingHandoff()` from `@goodvibes/engine/platform/platform/pairing`) with a
device name and the offer set it wants to present:

```ts
import { mintPairingHandoff, availablePairingOffers, defaultPairingTokenName } from '@goodvibes/engine/platform/platform/pairing';

const offers = availablePairingOffers({
  relayEnabled: true,       // relay.enabled + relay.url configured
  stepUpAvailable: true,    // the daemon runs the WebAuthn step-up service
});

const handoff = mintPairingHandoff({
  pairingTokens,             // a PairingTokenManager instance
  name: defaultPairingTokenName(), // e.g. 'paired device (2026-08-21 10:00 UTC)'
  offers,
  webOrigin: 'https://app.example.com', // the web app origin the link opens
});

// handoff.token.token is the plaintext secret, returned exactly once.
// handoff.fragment is '#pair=<token>&offers=...'
// handoff.deepLink is '<webOrigin>/#pair=<token>&offers=...' when webOrigin was given
// handoff.posture is the origin's honest TLS/capability posture (see below)
```

This mints a brand-new per-device token every time; it is not idempotent the way the legacy
`getOrCreateCompanionToken` was. Opening the pairing UI again mints a fresh token and QR rather
than reprinting the last one.

### Step 2: Host renders the QR

```ts
import { generateQrMatrix, renderQrToString, pairingQrContent } from '@goodvibes/engine/platform/platform/pairing';

const matrix = generateQrMatrix(pairingQrContent(handoff));
// matrix is a QrMatrix object: { size: number; modules: readonly boolean[][] }; modules[row][col] === true means a dark module
```

For TUI surfaces, `renderQrToString(matrix)` prints a block-character QR code. For graphical
surfaces, iterate `matrix.modules` over `matrix.size` rows and columns to draw the cells.

### Offer set

A single pairing exchange can carry an **offer set**, so a freshly-paired device completes
several setup steps in one pass instead of a separate flow per feature. Each offer is
independently declinable:

- **`notifications`.** Registers the device for browser push (the response carries the VAPID
  public key needed to subscribe). Always available; browser push needs no server-side
  prerequisite beyond the key the daemon mints on demand. The device's push endpoint must be a
  public `https` address (a browser vendor's push service): the daemon refuses loopback, private,
  link-local and plain-`http` endpoints, and never follows a redirect from one. A development push
  relay or local test sink on such an address needs `GOODVIBES_PUSH_ALLOW_LOCAL_ENDPOINTS=1` in the
  daemon's environment.
- **`relay`.** Acknowledges that the surface may connect through the rendezvous relay for
  off-LAN reach. Available only when the relay is configured; see
  [Zero-knowledge relay](./relay-zero-knowledge.md).
- **`passkey`.** Registers a WebAuthn credential for relay step-up. Available when the daemon
  runs the step-up service (the daemon always does).

`pairing.handoff.create` returns the offers actually available on this daemon that the new
pairing can complete; a surface presents only those. Completing needs what registering a
step-up passkey needs (full authority), so a pairing minted narrower than that (from a caller
holding a narrowed list) is offered nothing and gets its token alone. After the device scans and completes its side of each accepted offer, it
calls `pairing.handoff.complete` with its per-offer decisions in one pass. Each offer resolves
to an honest per-offer result (`completed` / `declined` / `unavailable` / `failed`); an omitted
or explicitly declined offer is reported as `declined`, never silently half-applied.

### Origin posture

Every hand-off carries the honest TLS/capability posture of the web origin the link opens (also
readable standalone via `pairing.posture.get`): whether the origin is plain http on a private
network (a supported posture, not an error), and, for each browser-gated capability (service
worker/PWA install, push notifications, microphone), whether it is available or needs https. See
[TLS posture](#tls-posture-http-on-your-lan-tailscale-for-the-full-pwa) below for the full
picture.

### Device cap

Pairing is bounded by `device.nodes.maxPaired`. A **new** device pairing at the cap is refused
with a named, actionable error (`PairingLimitReachedError`, wire code `DEVICE_NODES_MAX_PAIRED`)
that states the setting, the cap, and the current count. A device **re-pairing under a name it
already holds** is never refused by the cap. Its previous token is superseded, which is what
"re-pair this device" means, and the paired count does not creep upward. Lowering the cap below
the current count does not unpair anyone; it only blocks the next new pairing until enough
devices are unpaired to fit under it again.

---

## Per-device token lifecycle

- **List** paired devices with `pairing.tokens.list`: id, user-visible name, created timestamp,
  last-seen timestamp and, for a token a paired device minted, `mintedBy` (that device's id), plus
  whether the legacy shared token has been revoked. The secret is never returned by this call.
- **Rename** a device with `pairing.tokens.rename({ id, name })`. An unknown id is a 404
  `PAIRING_TOKEN_NOT_FOUND`.
- **Revoke** one device with `pairing.tokens.delete({ id })`. Revocation is immediate; the token
  fails the very next request with a 401. Every token that device minted (and any those minted)
  is revoked with it and listed in `alsoRevoked`, so cutting off a lost phone leaves nothing it
  handed out behind; every other paired device keeps working. An unknown id is a 404
  `PAIRING_TOKEN_NOT_FOUND`, never a `200`-noop.
- **Mint** a fresh token for the same use case pairing normally does, `pairing.tokens.create({
  name })` or `pairing.handoff.create`, both bounded by [the device cap](#device-cap). A token
  a paired device mints with `pairing.tokens.create`, `pairing.handoff.create` or
  `pairing.tokens.migrate` records that
  device as `mintedBy`; a device whose own pairing is gone cannot mint (403
  `PAIRING_TOKEN_NOT_FOUND`).
- **Limit** what a device may do with `pairing.tokens.create({ name, scopes })`: the device
  holds only those operator scopes (for example `read:sessions`, `read:transcripts` and
  `write:sessions` for a phone that only chats) and is not an admin. Left out, the device holds full operator
  authority. A caller grants only what it holds: a limited device's or user's new token
  inherits its list, and naming a scope the caller does not hold is 403 `MISSING_SCOPE`.
  `pairing.tokens.list` returns each device's `scopes`, and the web app's device list shows
  them. Local sign-in users take the same list through `local_auth.users.create({ scopes })`
  and `local_auth.users.scopes.set({ username, scopes })` (`null` returns the role's set).
  A user without the admin role reads status (counts, states, names, configuration) but none
  of the owner's content: mail, profile, purchases, dates, memory, transcripts, paired devices
  and peers, calendar, approvals and the questions waiting on the owner, named people,
  workspace file contents, and the records of the browser, knowledge, channels, automations,
  fleet and skills. Those reads need `read:email`, `read:profile`, `read:profile-document`,
  `read:payments`, `read:occasions`, `read:memory`, `read:transcripts`, `read:pairing`,
  `read:remote`, `read:calendar`, `read:approvals`, `read:principals`, `read:checkpoints`,
  `read:browser-content`, `read:knowledge-content`, `read:channel-content`,
  `read:automation-content`, `read:fleet-content` or `read:skill-content`, and a limited device
  holds one only when its list names it.

## Legacy: the shared token

Before per-device pairing tokens existed, every companion app shared one bearer token, and the
QR code encoded a raw JSON connection object instead of a deep link. This mechanism still works
today for backward compatibility and existing installs migrate off it device by device, but new
pairings should use the [Pairing flow](#pairing-flow) above instead.

### Generating the shared token

The host surface calls `getOrCreateCompanionToken(options)` to get the existing shared token, or generate one if none exists:

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getOrCreateCompanionToken } from '@goodvibes/engine/platform/platform/pairing';

const daemonHomeDir = join(homedir(), '.goodvibes', 'daemon');
const record = getOrCreateCompanionToken({ daemonHomeDir });
// record: { token, peerId, createdAt }
```

This is synchronous and idempotent. Calling it repeatedly returns the same record until
`regenerateCompanionToken` (host-level) or `pairing.tokens.revokeShared` (the operator verb) is
called. Token storage is daemon-home scoped (see [Storage](#storage)).

### Encoding and rendering

```ts
import { generateQrMatrix, pairingQrContent, renderQrToString } from '@goodvibes/engine/platform/platform/pairing';

const matrix = generateQrMatrix(pairingQrContent(handoff)); // handoff from mintPairingHandoff
const qrString = renderQrToString(matrix); // block-character QR for terminal output
```

### Companion side: parsing the legacy payload

Nothing in the platform produces this JSON payload any more; the web UI's
scanner still reads it so QR codes printed by older versions keep working.

```ts
// Companion-side (pseudocode)
const raw = qrScanner.scan();
const payload = JSON.parse(raw) as CompanionConnectionInfo;
await tokenStore.setToken(payload.token);
const platformClient = createGoodVibesPlatform({ baseUrl: payload.url, tokenStore });
```

### Migrating off the shared token

A client currently authenticated with the shared token calls `pairing.tokens.migrate` (giving it
a name) to mint its own per-device token without disrupting any other client still on the shared
token. This does **not** revoke the shared token; that is the separate, explicit
`pairing.tokens.revokeShared` call, which an operator makes once every client has migrated.

The client also sends an `attemptId` and sends the same one again if the reply is lost (a
timeout, a dropped connection, a daemon restart). While the token that attempt produced is
unused, the repeat returns that token (same id) under a new secret, so the lost secret never
works and no second token is created.

---

## Companion connects

Once a companion holds a token, whichever shape it is, every subsequent API call carries it as a
Bearer header:

```http
GET /api/control-plane/auth HTTP/1.1
Authorization: Bearer <token>
```

Use the platform's standard auth helpers to handle this automatically:

```ts
import { createGoodVibesPlatform } from '@goodvibes/engine/platform';
import { createMemoryTokenStore } from '@goodvibes/engine/platform/auth';

const tokenStore = createMemoryTokenStore();
await tokenStore.setToken(token);

const platformClient = createGoodVibesPlatform({
  baseUrl,
  tokenStore,
});

// All platformClient.operator.* and platformClient.realtime.* calls now include the Bearer header
const status = await platformClient.operator.control.status();
```

For React Native or Expo, prefer the built-in secure token stores rather than rolling a custom adapter:

- **Expo**: `createExpoSecureTokenStore` from `@goodvibes/engine/platform/expo`, backed by `expo-secure-store`
- **iOS**: `createIOSKeychainTokenStore` from `@goodvibes/engine/platform/react-native`, backed by iOS Keychain
- **Android**: `createAndroidKeystoreTokenStore` from `@goodvibes/engine/platform/react-native`, backed by Android Keystore

```ts
import { createReactNativeGoodVibesPlatform, createIOSKeychainTokenStore } from '@goodvibes/engine/platform/react-native';

const tokenStore = createIOSKeychainTokenStore({ service: 'com.example.gv' });
const platformClient = createReactNativeGoodVibesPlatform({
  baseUrl,
  tokenStore,
});
```

For `createMemoryTokenStore` (non-persistent, suitable only for ephemeral use or development), import from `@goodvibes/engine/platform/auth`.

### When the paired program and the daemon are on different builds

A paired program and the daemon check each other's build on every status read. A program older than the daemon's release line (an open web tab or a terminal program that was running when the daemon updated) says so once and stops taking part in shared work until it restarts: the terminal app and the Agent show `This process is running build 3.4.8; the daemon requires 3.5.0 or newer. It has stopped taking shared-session work, restart it to rejoin.`, and the web app shows **Reload to update** in its header and reloads by itself once nothing would be lost. A daemon older than the program needs (3.3.2 for the terminal app and the Agent, 3.1.2 for the web app), such as one on another machine that has not updated, is not used: `The daemon at http://server.lan:3421 is running build 3.2.0; this client requires 3.3.2 or newer, update the daemon.` (a notice in the terminal app, a warning banner in the web app; the Agent refuses each request with `the GoodVibes host at http://server.lan:3421 is older than this Agent build needs`). Every sentence, and what each program does next: [When a program is older than the daemon requires](../../../docs/installation.md#when-a-program-is-older-than-the-daemon-requires).

---

## Legacy shared-token lifecycle

### Creating a token

`getOrCreateCompanionToken({ daemonHomeDir })` creates a JSON record (`{ token, peerId, createdAt }`) if none exists at `<daemonHomeDir>/operator-tokens.json` and returns it. The file is written at mode `0600`.

### Regenerating a token

Calling `regenerateCompanionToken({ daemonHomeDir })` (equivalent to `getOrCreateCompanionToken` with `regenerate: true`) issues a new token and replaces the stored record. Any companion app holding the previous token will receive `401 Unauthorized` on its next API call and must re-pair.

```ts
import { regenerateCompanionToken } from '@goodvibes/engine/platform/platform/pairing';

const newRecord = regenerateCompanionToken({ daemonHomeDir });
```

Rotate tokens proactively if:
- The companion device is lost or stolen.
- You believe the token may have been observed by a third party.
- You are decommissioning a companion app.

### Reading a stored token

There is no dedicated `readCompanionToken` export. To inspect the stored record without regenerating, read `<daemonHomeDir>/operator-tokens.json` directly, or call `getOrCreateCompanionToken({ daemonHomeDir })`; it is idempotent and returns the existing record if present.

---

## Security considerations

> These notes are companion-pairing specific. For the daemon's full security model, authentication modes, token management, and secret handling, see [Security best practices](./security.md).

### Token storage on the host

Per-device pairing tokens are stored **hashed** (SHA-256): the file at
`<surfaceRoot>/control-plane/pairing-tokens.json` never holds a usable secret, only the hash,
the device's name, and its created/last-seen timestamps.

The legacy shared token is stored as a plaintext JSON file at `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`). This file should have user-only read permissions. The platform sets `0600` on creation and re-enforces it via `chmodSync` after write. Do not commit either file to source control; the daemon home directory should be outside any project tree.

### Token storage on the companion

On mobile companions:
- Use the platform's secure storage (iOS Keychain, Android Keystore).
- Use a `GoodVibesTokenStore` adapter backed by `expo-secure-store` or `react-native-keychain`, which use the platform keychain.
- Never store the token in AsyncStorage, localStorage, or other unencrypted stores.

### QR code exposure

The QR code (or deep link) encodes the token in plaintext, in the URL fragment. Treat the QR
code display like a password prompt:
- Do not record or screenshot the QR display in shared environments.
- The QR is displayed on-demand; each open mints a fresh per-device token, so scrolling it off
  the screen costs nothing.
- If you believe a shown code was observed by an unintended party, revoke that device's token
  (`pairing.tokens.delete`) rather than leaving it live; for the legacy shared token, regenerate
  it (see [Legacy shared-token lifecycle](#legacy-shared-token-lifecycle)).

### TLS posture: http on your LAN, tailscale for the full PWA

This is the honest picture, stated once (surfaces render the same line from the
pairing contract, never as a recurring nag):

**Plain http on your LAN works, and is a supported posture.** A phone on the
same private network (a `10.x`/`172.16-31.x`/`192.168.x` or link-local address,
an IPv6 unique-local or link-local address, a `.local` mDNS name, a Tailscale
`*.ts.net` name, or localhost) uses the full cockpit over http.
The transport does not refuse private-network origins; the one rule is
`isPrivateNetworkHost` in `transport-http`, which the web UI's start-up guard
imports. Over a Tailscale name or address the connection is already encrypted
by Tailscale, and the posture notice says so instead of the LAN line.

A `100.64-127.x` address is accepted over http only as a Tailscale address,
because carrier-grade NAT uses the same range and an http request to it would
cross the ISP's network unencrypted with the bearer token. The daemon, the
terminal app and the Agent ask a running Tailscale (`tailscale status`) the
first time such an address comes up and accept exactly the addresses it lists
for this machine and its peers; the answer is reused for a minute, so a
stopped Tailscale stops vouching for them. Without Tailscale on the machine,
list the addresses in `GOODVIBES_TAILNET_ADDRESSES` (comma-separated, or
`100.64.0.0/10` for the whole range when no carrier-grade NAT is in the path)
or use the Tailscale name. A browser cannot ask, so the web UI is opened by
the Tailscale name.

The host in a pairing link, a QR or `web.publicBaseUrl` for a wildcard bind
comes from one rule (`stableUrlHostForBindHost`): the Tailscale MagicDNS name
when Tailscale is up; `<host>.local` only when that name was looked up and
resolved to one of this machine's addresses; the address of the interface that
carries the default route; the first non-internal address. The Tailscale and
`.local` probes run asynchronously and are cached for the process, so showing a
link never blocks on them. When a name wins, the routable address comes back
beside it (`alternateOrigin`) and the pairing surfaces print it as a fallback.

Two things are true about plain http on the LAN:

1. The connection is unencrypted on your local network. Anyone who can already
   capture traffic on your LAN can read it, including the bearer token.
2. Browsers gate a few capabilities on a *secure context* (https, or the
   localhost loopback): **service worker or PWA install, push notifications,
   and the microphone**. On plain http over the LAN these are unavailable.
   the daemon reports each one in the pairing/posture contract
   (`pairing.posture.get`, and the `posture` field of `pairing.handoff.create`)
   so surfaces show a "needs https, available via tailscale" label instead of
   a dead button. Localhost keeps all three.

**Full PWA needs TLS, and TLS on a home network is your responsibility.** The
daemon never mints certificates and never provisions its own CA. If you
already run real TLS (a reverse proxy with a real certificate), that works
as-is via the daemon HTTP policy's TLS configuration.

**Tailscale is the recommended path.** Encrypted access and a real https URL
with zero certificate handling on your side. Worked example:

```bash
# One-time: install tailscale on the daemon host and the phone, log both in.
tailscale up

# Front the web UI the daemon serves (its control-plane port, default 3421) at
# your MagicDNS name. TLS is terminated by tailscale; the daemon never touches a certificate.
tailscale serve --bg 3421

# The daemon is now at e.g. https://yourhost.your-tailnet.ts.net;
# open that on the phone: secure context, full PWA, push, microphone.
```

The daemon offers this as a one-action affordance: `tailscale.get` (read-only
detection: binary, logged-in state, MagicDNS name; where tailscale is absent,
nothing nags), `tailscale.serve.run` (runs the serve command above for you on the port the
web UI is served on, refused with 409 `WEB_UI_NOT_SERVED` when none is, records
an honest receipt, and updates `web.publicBaseUrl` to the https URL) and
`tailscale.serve.stop` (runs `tailscale serve --https=443 off` and puts
`web.publicBaseUrl` back to what it was before). Tailscale keeps a serve on,
also after the daemon stops, until it is stopped; `tailscale.get` shows the
serve that is on as `activeServe`. When the tailnet has Serve turned off,
tailscale prints a link to turn it on, and the receipt carries that link as
`enableUrl`.

### Token rotation

Per-device tokens do not need scheduled rotation the way the legacy shared token did. Every
device already holds its own token, so revoking one (`pairing.tokens.delete`) never disrupts
any other device, and the low-friction response to loss, theft, or suspected exposure is to
revoke that one device and let it re-pair, not to rotate a token every device shares.

For the legacy shared token, implement an explicit rotation policy appropriate for your threat
model:
- Low-risk local use: rotate on device loss or on demand.
- Cross-network or shared-host use: consider periodic rotation (e.g. monthly) via `regenerateCompanionToken`, or migrate every client off it (`pairing.tokens.migrate`) and revoke it (`pairing.tokens.revokeShared`) instead.

---

## Integration examples

### TUI: Pair something, A phone or another device

In the TUI, the Devices and network place (Ctrl+G, m) has Pair something on every tab; choosing A phone or another
device opens the device-pairing modal: a QR of the `#pair=<token>` deep link plus the offer set. A script or a model
reaches the same capability as `devices.pair`; it runs only in the program holding the conversation, and only when
the owner presses it.

The token the modal shows is an offer: no device is added until one uses it, and an unused
offer stops working after 15 minutes. Reopening the modal shows the same offer while it is
unused and unexpired, so looking at the QR again adds nothing. Pressing `r` shows a new offer in
its place; the one it replaces stops working unless a device already paired with it. A device
that paired stays until it is revoked in Devices and network (`x` on the device, or `pairing.tokens.delete`). `device.nodes.maxPaired` applies to the TUI's own
pairings as it does to the daemon's: an unused offer does not count toward it.

### Daemon CLI `pair` command

`goodvibes-daemon pair` (aliases `qr`, `qrcode`) prints the pairing block, made up of the web
origin, the offer set, and a QR code encoding the deep link.

Every pairing surface (this command, `goodvibes pair`, `goodvibes-agent pair`, the TUI modal above
and the web UI's `Pair a new device`) first asks whether another device could open the address
the code carries. A loopback address cannot; an address equal to `web.publicBaseUrl` can; any
other address can only with `controlPlane.enabled`. The daemon answers it in
`pairing.posture.get` (`reach`) and enforces it in `pairing.handoff.create`, which refuses with
`409 PAIRING_CODE_UNREACHABLE` unless the code is for a browser on the daemon's own machine
(`forThisMachine: true`). When no other device could open it, no QR is shown and no code is made
for a phone: the code is made for a browser on the daemon's own machine (`forThisMachine`),
led by `This link signs in a browser on this computer. A phone cannot open it: <why>.` and
numbered steps whose next step is `goodvibes-daemon webui enable --lan`, then the link and the
sign-in code (`pairingThisMachineLines`). A client reaching a daemon on another machine gets the
steps and no code.

```bash
# Local form: reprint the daemon's own pairing block.
goodvibes-daemon pair

# Remote form: mint a NEW per-device token on another daemon and print its block.
goodvibes-daemon pair --host <name> [-y]
```

**Local form** (no `--host`, or one naming this machine) reprints the **existing shared token**
rather than minting a new one, so a link printed here and the one printed at boot are the same
link; scrolling the startup banner off the screen costs nothing.

**Remote form** (`--host` naming another machine) asks that daemon to **mint a new** per-device
pairing token and prints the pairing block for it. Minting is a different act than reprinting:
it is a fresh token, and every token that daemon already issued, its shared token included, is
left untouched. Because this changes state on a daemon that may not be the local process's own,
it states the plan and asks for confirmation before acting (`-y`/`--yes` for the non-interactive
answer); an unreachable daemon, a rejected token, or a daemon too old to serve the mint verb are
each refused by name.

> **platform vs host wiring:** The TUI's Pair something (A phone or another device) and the `goodvibes-daemon pair` subcommand
> are host-application wrappers, not platform exports. The primitives they compose,
> `mintPairingHandoff`, `pairingQrContent`, `generateQrMatrix`, `renderQrToString`, and
> `getOrCreateCompanionToken`, are all
> exported from `@goodvibes/engine/platform/platform/pairing` and can be composed directly by any
> embedder.

---

## Building a companion app

### What the companion needs

A companion app requires:

1. **A QR scanner, or a deep-link handler.** To capture the pairing code displayed by the host surface, either a camera scan (native camera APIs or libraries like `expo-barcode-scanner`) or, for a web/PWA companion, handling its own app being opened at a `#pair=<token>` URL. Either way, parse the result with `parsePairingHandoffLink()` from `@goodvibes/engine/platform/platform/pairing` (current flow) or `JSON.parse()` (legacy payload; see [Legacy: the shared token](#legacy-the-shared-token)).

2. **Persistent, secure token storage.** To retain the companion token across app restarts. See the token storage guidance above.

3. **An HTTP client.** For all request/response interactions. The platform handles this when used as a client library. For native Kotlin/Swift apps without the platform, use standard `fetch`, `URLSession`, or `OkHttp` with the `Authorization: Bearer <token>` header.

4. **An SSE or WebSocket connection.** For realtime event delivery. The daemon exposes both:
   - SSE: suitable for Bun and browser clients.
   - WebSocket: recommended for React Native and Expo because it has broader React Native support.

### Minimal integration pattern (React Native / Expo)

```ts
import { createReactNativeGoodVibesPlatform, createIOSKeychainTokenStore } from '@goodvibes/engine/platform/react-native';

// createIOSKeychainTokenStore and createAndroidKeystoreTokenStore are available from
// @goodvibes/engine/platform/react-native. For Expo, use createExpoSecureTokenStore
// from @goodvibes/engine/platform/expo.
const tokenStore = createIOSKeychainTokenStore({ service: 'com.example.goodvibes' });

export function usePairedPlatform(baseUrl: string) {
  const platformClient = createReactNativeGoodVibesPlatform({
    baseUrl,
    tokenStore,
  });
  return platformClient;
}

// After scanning the QR code (or opening the deep link):
import { parsePairingHandoffLink } from '@goodvibes/engine/platform/platform/pairing';

async function onPairingLinkReceived(scannedOrOpenedUrl: string) {
  const parsed = parsePairingHandoffLink(scannedOrOpenedUrl);
  if (!parsed) return; // not a pairing link
  await tokenStore.setToken(parsed.token);
  // parsed.offers names which setup steps (notifications/relay/passkey) this
  // pairing carries; complete them with pairing.handoff.complete.
  // platformClient is now ready to use with the stored token
}
```

### Minimal integration pattern (native Android / iOS)

Native clients that do not use the TypeScript platform can connect using standard HTTP:

```
# Verify the token is working
GET /api/control-plane/auth
Authorization: Bearer gvp_abc123...
```

For realtime events, open a WebSocket to:

```
ws://<daemon-host>:<port>/api/control-plane/ws
```

with the same `Authorization: Bearer <token>` header (or as a query parameter if the WebSocket client library does not support custom headers).

Event envelopes arrive as JSON-serialized `SerializedEventEnvelope` objects. The schema is exported as `SerializedEventEnvelopeSchema` from `@goodvibes/engine/platform/contracts`.

### Handling token invalidation

When a device's token is revoked (`pairing.tokens.delete`), or the legacy shared token is
regenerated or turned off, that device's connection starts receiving `401` responses. Implement a re-pairing flow:

```ts
platformClient.operator.control.status().catch(async (err) => {
  if (err.kind === 'auth') {
    // Token has been invalidated; prompt user to re-scan the QR code
    showRepairingScreen();
  }
});
```

The recommended UX is to show a re-pairing prompt rather than a generic error screen, since token invalidation is an expected operational event (not a crash or network failure).
