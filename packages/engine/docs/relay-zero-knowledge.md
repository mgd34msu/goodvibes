# Zero-knowledge relay: reachability without a trusted operator

The relay makes a durable daemon (an always-on box) reachable from a surface
(webui / PWA on a phone) that is **off the LAN**, without any party, including
whoever runs the relay, being able to read the traffic. This page states the
design and, plainly, exactly what the relay can and cannot see.

The rule this implements: if GoodVibes ships reachability, it is the
zero-knowledge, self-hostable relay or nothing. Every vendor "remote control"
relay routes traffic the vendor can read; this one cannot.

## Shape

```
  surface (off-LAN)                relay (any VPS)                 daemon (home box)
        |                               |                                |
        |                               |◄────────────── register(rid) ──|  (outbound)
        |                               |── challenge(nonce) ───────────►|
        |                               |◄──────── prove(key, signature) ─|
        |                               |── registered(maxMessageBytes) ►|
        |  connect(rid) ───────────────►|                                |
        |◄── connected(pipe, maxMessageBytes) ─|── pipe-open(pipe) ──────►|
        |                               |                                |
        |═══ E2E handshake (NK) ════════╪════════════════════════════════|
        |═══ ciphertext ════════════════╪═══ ciphertext (═ [pipe]+ct) ═══|
```

- The **daemon dials the relay outbound** and registers under its
  **rendezvous id**. It needs no inbound port and no public IP. The id is
  derived from the daemon's identity key, and the relay registers it only after
  the daemon signs a fresh challenge with that key, so a device that saw a
  pairing code (including one whose pairing was later revoked) cannot take the
  id. A proven registration replaces a stale one for the same id, so a daemon
  whose network changed is not locked out by its own dead connection. A
  connection that has not received the relay's `registered` frame within the
  registration deadline (`registrationTimeoutMs`, 15 seconds by default) is
  closed and retried through the normal reconnect backoff. An error frame from
  the relay before registration completes is handled the same way, and the
  registration keeps the relay's reason and next step (`lastRefusal`).
- Once registered, the daemon **pings the relay every 25 seconds**
  (`keepaliveIntervalMs`); the relay answers each. An interval that ends with
  the last ping unanswered (a network change or suspend that dropped the path
  without closing it) ends the connection and re-registers, so `registered`
  means the relay answered within the last two intervals (`lastConfirmedAt`).
- A **surface dials the same rendezvous id**; the relay pairs the two and
  multiplexes many surface pipes over the one daemon socket.
- Before any application byte, an **end-to-end (E2E) handshake** runs *inside*
  the pipe. Everything after it is ciphertext the relay forwards verbatim.
- The relay states the largest message it forwards (`maxMessageBytes`, 4 MiB
  by default) in `registered` and `connected`. A request or response larger
  than that is sent as consecutive fragments, so opening a large attachment
  from a phone reaches it instead of closing the connection. A frame over the
  limit from a daemon closes only that one pipe, never the registration and
  the other devices' pipes. One buffered response is capped at 32 MiB (502
  past it) and one request at 64 MiB (413 past it).
- A request whose caller asks for a **streamed answer** (an `Accept` of
  `text/event-stream` or an audio type, or a JSON body with `"stream": true`)
  is sent with its method and body as a stream: the daemon answers with the
  real status and headers first, then the bytes as they are produced, so
  streamed chat completions and streamed speech start as soon as their first
  bytes exist.

## The E2E handshake (primitives)

A Noise **NK**-style authenticated key exchange, built only from Web Crypto
primitives: no new dependency, nothing hand-rolled:

- **ECDH over NIST P-256** for key agreement (universally available across the
  browser PWA, Bun daemon, and Node; matches the curve already used for push
  encryption).
- **HKDF-SHA-256** to derive keys, bound to the full handshake transcript
  (rendezvous id + both ephemeral public keys + the daemon static public key).
- **AES-256-GCM** for the record layer, with per-direction keys and
  strictly-increasing counters so a (key, nonce) pair is never reused and
  replayed/reordered frames are rejected.

The surface pins the **daemon's static public key** from the pairing payload.
The derived keys mix a static-ephemeral DH against that pinned key, so:

- **Daemon authentication.** Only the real daemon holds the matching private
  key, so a curious or malicious relay that tries to sit in the middle cannot
  derive the session keys; its forged handshake confirmation fails and the
  surface tears the pipe down.
- **Forward secrecy.** An ephemeral-ephemeral DH means recording ciphertext and
  later stealing the daemon's static key still does not reveal past sessions.

## Trust bootstrap: the pairing payload

Trust starts with a **pairing payload**, a compact, QR-encodable string
(`gvrelay1.…`) carrying the relay URL, the rendezvous id, the daemon's
pinned static public key and a relay code issued for that one device. Deliver
it out-of-band (scan a QR on the same LAN, copy the string). This is the same
trust model as an SSH host-key fingerprint or pairing a phone by scanning a
code. The relay client sends the code (`x-goodvibes-relay-code`, inside the
encrypted channel) on every tunneled request; the daemon keeps only its hash and
refuses a request whose code it did not issue or has revoked (401
`relay-code-revoked`). `relay.codes.list` lists the codes and
`relay.codes.revoke` revokes one, so one device loses relay access without any
other. **Treat a valid pairing payload like a credential**: whoever holds one
can reach the daemon through the relay until its code is revoked.

## What the relay can and cannot see

**Cannot see** (structural, not policy):

- Request/response contents, paths, headers, bodies, auth tokens: all inside
  the AES-256-GCM tunnel. The operator's bearer token rides *inside* the tunnel.
- The E2E keys: every key derives from DH secrets the relay never receives.

**Can see** (connection metadata, stated plainly):

- Which rendezvous id a daemon registered, the daemon's public identity key
  (in the registration proof; it is also in every pairing code), and which
  surfaces paired with it.
- The multiplexed **pipe ids** it assigns for routing.
- **Traffic-analysis signals**: message sizes, counts, and timing.
- Network-level metadata (source IPs, connection lifetimes).

## What a malicious relay could do

- **Read content?** No. It only ever forwards ciphertext.
- **Impersonate the daemon (MITM)?** No. It lacks the pinned static private
  key, so it cannot complete the handshake.
- **Traffic analysis.** Yes: it sees sizes/timing/pairing metadata and can
  fingerprint activity. If that matters, run your own relay.
- **Denial of service.** Yes: like any middlebox it can drop or delay traffic,
  or refuse to pair. This is why the relay is **self-hostable**. The honest
  answer to "don't trust the operator" is "be the operator." A public instance
  is defended by caps (max daemons/pipes/per-daemon pipes/message size) and
  per-address handshake rate limiting so it cannot be turned into a liability,
  but it can never be made trustworthy for availability the way a self-hosted
  one is.
- **No accounts, no stored state** on the relay. Nothing to breach there.

## Security controls around the path

- **WebAuthn step-up on mutating relay calls.** Reaching the daemon off-LAN is
  higher-risk than a call on the trusted LAN, so an operator can require that
  *state-changing* operator calls arriving via relay carry a recent WebAuthn
  (passkey) step-up assertion (`relay.requireStepUpForMutations`). The gate
  judges the operator method the tunneled request calls (its REST path, or the
  id in `/api/control-plane/methods/<id>/invoke`): a method whose scopes are all
  `read:*` is a read and passes, any other scope means it changes state and needs
  the assertion, whatever HTTP verb carries it. Only a path that no operator
  method covers is judged by its verb (anything but GET, HEAD and OPTIONS). The
  setting is read on every request, so turning it on or off applies to the next
  relayed call without a restart. Register a passkey (below) before turning the
  requirement on: with none registered, every gated relay call is refused with
  `action: "register-locally"`, and registering is itself gated over the relay. The ceremony is now **real and bundled** (no external
  WebAuthn library):
  - **Register** a passkey with the admin/local-only `stepup.credentials.register`
    verb: it stores the credential (`credentialId`, COSE public key, starting
    signature counter) in the daemon's secret store and records the deployment
    policy (relying-party id, allowed origins, user-verification requirement).
    `stepup.credentials.list` (`GET /api/stepup/credentials`) shows the
    registered passkeys without key material, and `stepup.credentials.remove`
    (`DELETE /api/stepup/credentials/<credentialId>`, admin only, answers 404
    for an unknown id) removes one, for a lost device.
  - **Mint** a short-lived, single-use challenge with `stepup.challenge.mint`
    (`POST /api/stepup/challenge`; freshness window `ttlMs`, clamped 5s–300s,
    default 120s; at most 256 challenges wait at once, a further mint is
    refused until one is used or expires). Pass the `method` and `path` of the
    call the assertion is for: a challenge is accepted only for that method and
    path, and only from the principal (shared token, paired device or user)
    that minted it. A challenge minted without `method` and `path` can be
    signed, as a device self-test, but authorises no call. `sessionId` and
    `rendezvousId` narrow it further to that session (`/api/sessions/<id>/...`)
    and that rendezvous. Minting is a read-scope method, so it is never gated:
    it is the prerequisite for producing an assertion, and requiring one would
    deadlock. Credential registration (`POST /api/stepup/credentials`) is a
    write and **is** gated.
    One relying-party id and origin policy covers every credential: a
    registration for a different relying-party id is refused while credentials
    exist for the first, and further origins for the same relying party are
    added to the allowed ones.
  - **Present** the assertion on the mutating relayed request in the
    `x-goodvibes-stepup-assertion` header: the base64url encoding of the JSON
    object `{credentialId, authenticatorData, clientDataJSON, signature}`
    (each field base64url, as `navigator.credentials.get` returns them). A
    request without a verifiable assertion is answered `401` with a
    `www-authenticate: WebAuthn` header and the daemon's usual refusal body
    (`code: "step-up-required"`, `state`, `error` saying why, `next` saying
    what to do) plus two fields to branch on: `reason` (for example
    `assertion-missing`, `no-credential`, `challenge-expired`,
    `challenge-consumed`, `unknown-challenge`, `challenge-unbound`,
    `signature-invalid`) and `action`:
    - `sign`: no assertion was sent; mint a challenge for this call, sign it
      and send the call again with the header.
    - `mint-again`: the challenge is expired, used, unknown or minted for
      another call; mint a new one for this call.
    - `re-sign`: the signature did not verify; sign again.
    - `register-locally`: no passkey the daemon could accept is registered;
      register one while connected directly (same network), then try again.
      The web UI opens no passkey dialog for this one.
  - **Verify.** The daemon's `StepUpAssertionVerifier` (node/Web Crypto only)
    checks, in order:
    1. `clientDataJSON` type is `webauthn.get`, its challenge is a
       live+unconsumed one we minted, its origin is allowed.
    2. The `rpIdHash` equals SHA-256(rpId).
    3. The user-presence flag is set (and user-verification when the policy
       requires it, default required).
    4. The P-256 ECDSA signature over
       `authenticatorData || SHA-256(clientDataJSON)` is valid.
    5. The signature counter has not gone backwards (a cloned-authenticator
       signal).

    Only a complete pass consumes the challenge and advances the stored
    counter; the counter is written back only when the passkey advanced it
    (many passkeys always report 0, and for those an accepted call writes
    nothing). Every other path **fails closed**. It denies rather than
    allowing or faking a pass, and nothing ever reports an unverified
    assertion as verified.

  **Threat model: 'none' attestation.** Registration accepts the credential's
  COSE public key directly and does **not** verify an attestation certificate
  chain ('none' attestation). This is the standard, deliberate posture for a
  self-hosted deployment: there is no central RP verifying which *make/model* of
  authenticator an operator uses, and registration is already an admin/local-only
  act on the daemon the operator controls. The security of the control rests on
  the signature check against the registered public key and the single-use,
  time-bound challenge, not on attestation provenance.
- **LAN HTTPS posture: the daemon never mints certificates.** There is no
  self-provisioned CA and no daemon-generated certificate, ever. The
  recommended path to https is **tailscale serve**: it fronts the daemon's
  port and terminates TLS with tailscale's own certificates, certificate
  issuance and renewal are tailscale's business, never the daemon's. The
  daemon side is strictly read-only detection plus one explicit
  user-initiated enable (`tailscale.get` / `tailscale.serve.run`; see
  `platform/remote-access/tailscale.ts`). Where tailscale is absent, LAN
  access stays plain http on the interface the operator chose, an honest
  posture rather than a locally-minted trust root.
- **Relay connections are visibly distinct.** Every tunneled request is tagged
  with an `x-goodvibes-via-relay` header (`isRelayTunneledRequest`), and the
  daemon exposes the relay registration status, so surfaces can show a
  connection as "via relay" and apply relay-specific policy.

## Enabling it

No relay connection is ever made without explicit configuration. Enablement is
gated three ways, mirroring how other optional capabilities gate themselves:

1. `relay.enabled` (default `true`, the capability is ready),
2. the `relay-connect` runtime-toggleable feature (default enabled), and
3. a configured `relay.url` (default empty, nothing to dial).

All three must agree before the daemon opens an outbound registration; with no URL
configured, or with either gate switched off, the relay path is byte-for-byte inert
and the daemon stays LAN-only.

The registration itself is opened when the daemon starts, so enabling relay
access, or changing `relay.url`, takes effect at the next daemon start. The
rendezvous id is not a choice: the daemon records the id derived from its
identity key in `relay.rendezvousId`, and `relay.reachability.get` reports it
while a registration runs. Turning `relay.enabled` or the `relay-connect` feature off applies
at once to traffic: a request that arrives over an already-open registration is
answered `503` with code `relay-disabled` (its `next` says to connect directly
or turn relay access back on) until the daemon is restarted.

Run your own relay with the bundled server:

```
GOODVIBES_RELAY_PORT=8787 bun node_modules/@goodvibes-jev/engine/daemon-api/dist/relay-server-entry.js
```

`GOODVIBES_RELAY_PORT` sets the port (default 8787). `GOODVIBES_RELAY_HOST` sets
the interface to bind; leave it unset to listen on all interfaces, or set it to
`127.0.0.1` when a reverse proxy on the same machine terminates TLS. The relay
limits handshake attempts per client address, so behind a proxy all clients
share the proxy's allowance.

Put it behind TLS (`wss://`) at the edge, point `relay.url` at it, pair a surface
with the daemon's QR (`relay.pairing.mint`, an admin verb that returns nothing
until the daemon has registered; `relay.reachability.get` reports the
registration status), and you have reachability that no operator, not even you,
running the relay, can read.

## Live event streaming over the relay

The tunnel carries **both** unary request/response calls and **live event
subscriptions**. A request whose `Accept` is `text/event-stream` is opened as a
streaming subscription over the same E2E channel rather than a unary call:

- The client sends a `stream-open` frame; the daemon dispatches it against its
  own event source (the existing SSE route) and bridges the source's bytes back
  as sealed `stream-data` frames, ciphertext to the relay, exactly like every
  other payload.
- **Flow control.** The daemon reads the source with natural backpressure and
  holds a **bounded** per-stream send buffer. If a slow consumer makes it
  overflow, chunks are dropped and **counted**, and a `stream-overflow` frame
  carries the dropped count, the client surfaces it as a visible
  `relay-overflow` SSE event. Never a silent gap. Per-pipe stream count is
  capped, consistent with the relay server's other limits.
- **Clean close** is explicit in both directions (`stream-close`): the daemon
  closes when its source ends or errors; the client closes (unsubscribing the
  daemon's source) when the consumer stops reading.

Because the client exposes this through its relay-backed `fetch`, the existing
Server-Sent-Events connector idiom (`openServerSentEventStream`, which just calls
`fetch` and reads the streaming body) works over the relay unchanged, a surface
that today rejects SSE over relay can drop that rejection and call it directly.


### Unary judgment cancellation

The exact `POST /api/judgment/batteries/run` route waits for its daemon-owned
judgment without a relay unary timeout. Other unary routes retain the configured
request timeout. This adds no relay retry loop and does not extend authentication,
source-reference expiry, or outbound authority; the judgment service rechecks
those boundaries independently.

Caller cancellation and ordinary unary timeout send an encrypted `request-cancel`
frame for the same request id. The daemon owns that request's AbortController
through dispatch and response buffering, and also aborts it on pipe closure,
pipe eviction, disconnect, reconnect, and registration shutdown. In-flight slots
remain occupied until dispatch actually drains, including a dispatch that ignores
abort; a late answer is never delivered. Response readers cancel without waiting
for an uncooperative source cancellation hook. Request/cancel admission and client
encrypted sends are ordered so cancellation cannot overtake its request. All
unary/refusal/stream daemon sends share the same per-channel seal-and-send queue,
and client frame opening is serialized in wire order; asynchronous crypto cannot
reverse AEAD counters. Queues are bounded by frame count and 64 MiB of queued
frame bytes. Saturation closes the owning pipe rather than retaining unbounded
work. Ownership is rechecked after encryption, including overload/size/streaming
refusals, so a retired or cancelled request cannot send a late response.

A daemon can ask the relay to close only a pipe belonging to its registered
socket. Eviction therefore releases the client wait as well as daemon work,
without allowing one daemon to close another daemon's pipes.
