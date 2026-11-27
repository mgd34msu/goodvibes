# TUI-owned host pairing

Native `/work`, native headless intake and legacy work-import commands resolve a captured credential from `.goodvibes/tui/connected-host-credentials/credentials.json` under the selected TUI home. Records are keyed by canonical HTTP(S) origin: scheme, host and port. Another origin does not receive this credential. Paths, user information, queries, fragments and ambiguous input are refused.

No native path reads the Agent's private store or an environment credential. For the daemon on this machine (a loopback origin) with no TUI credential saved, native paths present the daemon's operator token from the owned mode-0600 `.goodvibes/daemon/operator-tokens.json`, read only when the file is owned by you, mode 0600 and not a link, and kept while that file is unchanged: the daemon treats it as the owner's own machine, so no pairing is needed there. The daemon decides that from the connection: a direct loopback request addressed to a loopback name with no proxy forwarding header, while no public address (`controlPlane.publicBaseUrl`, `web.publicBaseUrl`, `cloudflare.daemonHostname`) is configured; through a tunnel or reverse proxy, or on a published daemon, the TUI pairs as any other device does. That token is never sent to a daemon on another machine. Missing, unsafe and indeterminate stores fail closed. Resolution is passive: no directory creation, credential generation, adoption, fallback, repair, rotation or revocation. Reading a saved credential does not grant write/admin authority; live read scopes remain sufficient for supported reads. Native submission/intake separately require a live owner credential (a paired device, or the operator token from this machine, which the daemon reports as `local`), administrative authority and read/write-work-ledger scopes.

## Pairing this terminal with a daemon on another machine

The existing `goodvibes pair` and Pair something, A phone or another device (in the Devices and network place) still create companion/WebUI handoffs. This terminal becomes the owner's own device with a sign-in code the owner starts in person, where they are signed in as themselves (that daemon's web UI with their password, or their terminal app on that machine: Devices and network, Pair something, "Show the sign-in code once"):

```sh
goodvibes host pair                                    # type or paste the code when asked
goodvibes host pair --url https://studio.example:3421 --name laptop
goodvibes host unpair [--url <exact-origin>]
```

The code is read from the terminal, never from an argument (other processes can read those). The daemon confirms it as a device of the owner's, and this terminal keeps it for the selected host. Nothing else is asked. `--url <exact-origin>` selects an in-memory endpoint for this command only; it does not persist a new endpoint or enable a disabled daemon. `--name <device-name>` is the device label (default `GoodVibes TUI`). Unsupported options print the one usage line and exit `2`; without an interactive terminal it says the code is typed in a terminal and exits `2`; Enter alone cancels (`2`); Ctrl-C or a termination signal exits `130`. Paired exits `0`; a code the host did not take (already used, older than 15 minutes, or never one) or a host that could not be reached exits `1`, in one sentence saying what to do. The standalone route runs before ordinary startup, onboarding, daemon adoption or model/tool composition.

Inside the live TUI the same is Pair something, This program with its daemon, in the Devices and network place (Ctrl+G, m): the code is typed into its field, Name is the device label, and the place uses the configured host. With no code the control says how this terminal reaches its daemon (with the daemon on this machine there is nothing to pair). Only the owner's own press in the place counts as the owner's act; a model's call, `capabilities.run` from another program, and copied or nested contexts are refused in one line. TUI and Agent credentials stay separate.

## Durability and interruption

A private durable `unknown` attempt is published before exactly one pairing request. Independent processes use a strict ownership lock and compare-and-swap; concurrent attempts cannot both pair for the same origin. Requests reject redirects and responses are bounded and validated. The credential is saved before it is checked against the host. A cancellation or a selection change before the request is sent creates nothing and releases the record. After the request was sent, a lost or invalid answer, a timeout or a restart preserves `unknown`: the result says the host's answer was lost, that a key made for it was never received and stops working within 15 minutes, and that `goodvibes host unpair` forgets the attempt before pairing again with a new code. It never pairs a second time on its own.

## Forgetting a credential

When the host no longer accepts the stored credential (it was revoked there, or the daemon was reset), pairing again says so. `goodvibes host unpair [--url <exact-origin>]` and Forget its daemon pairing on the Paired tab of Devices and network (pressed by the owner) forget the stored credential for the selected host, or an earlier attempt whose reply was lost, at any time; it exits `0` when something was forgotten and `1` otherwise. Forgetting is local: the token stays valid on the host until it is revoked there. Then pair again with a new sign-in code. Do not delete the recovery marker by hand.

The store refuses corrupt/oversized data, unsupported schema, duplicate origins, unsafe ownership/modes, symlink ancestry, symlink files and hard links. Each refusal names the cause, the path and the expected value (for example a file with mode 0644 where 0600 is required, with the `chmod` to run). A lookup is one read of the file; the writer makes it durable before returning. It uses atomic durable mode-0600 files inside a mode-0700 private store directory. Existing insecure paths are not silently changed. Current storage qualification is POSIX: on a runtime lacking effective-user ownership verification, pairing fails closed instead of claiming Windows support.

## Validation boundary

Credential or endpoint changes invalidate pending readers, discovery, preflights and queued mutation permits.

Successful pairing establishes the expected host credential only. Provider setup, workspace trust, Jev state, native evaluator semantics, admission and execution readiness remain independent checks.
