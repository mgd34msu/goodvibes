# Cluster operation outcomes

Creating, joining, rejoining and leaving reserve one operation per daemon. A second concurrent membership request returns `not-sent`; wait for the first operation before retrying. Shutdown cancels work that has not entered persistence and drains work already admitted before releasing its stores.

A membership change that has already received a successful storage acknowledgement finishes its matching roster record during shutdown. It does not re-enable the stopped daemon's signing keys.

`persistence-unknown` means a storage write or deletion started and its complete result could not be confirmed. The operation may have taken effect. GoodVibes disables live group authority and preserves the saved files; it does not retry the effect, restore old keys or claim that nothing changed. Inspect `cluster status` and the membership store, then restart to reconcile saved membership before deciding whether another operation is necessary. HTTP cluster refusals return status 409 with the structured `failure` field.

A saved configuration replica is used only with its own group ID. Changing groups does not cause a previous group's replica to become the new group's configuration after restart.

The public group ID and join key remain compatible with released peers. Before their first authenticated JOIN, both peers derive the same 16-byte scrypt salt using the existing fixed public `goodvibes-join-salt-v1` HMAC representation. This label is public, contributes no secret entropy and does not provide anonymity. Normal membership, key rotation and live guards reuse stored material without repeating this salt derivation.

Configuration transfers remain bound to the original live group and member generation across storage waits. Removing and re-adding a member, retiring the authenticated key generation, changing the group, or stopping the daemon prevents later writes or secret transmissions from that request. Ordinary heartbeat and display-name updates do not interrupt it. A write already entered before authority changes remains owned through completion; it is not blindly undone.

Group envelopes use a shared group key. These checks restrict the claimed sender against the current roster; they do not turn that shared key into an independent signature for each machine.

## Local configuration and credentials

The daemon subscribes to successful configuration and credential-store changes.
Only paths declared group-scoped by the platform policy are eligible; local
ports, transport identity, user preferences and unrelated provider credentials
stay on their original machine. A local configuration reset publishes its
resolved default; an explicit group deletion publishes a tombstone. Standby
edits and credential deletions are proposed to the master, which issues the
revision. Explicitly setting a deleted setting again clears that deletion.

On first master ownership in a membership incarnation, existing eligible
credentials are seeded once. Absent values do not become deletion requests, and
ordinary housekeeping does not repeatedly read every credential. Later changes
are event-driven. Failed changes retain only bounded path metadata for retry
under their original membership; a departed or revoked owner cannot transfer
that pending work to a new group. Stop removes listeners and drains entered
work before completing.

Receiving a setting or credential does not announce it back as a fresh local
edit. Suppression belongs to the particular entered store operation and exact
key, so unrelated local edits still replicate. Credential values remain in the
local encrypted store and recipient-sealed network payloads, never in replica
files, status or a private change-value cache. Signed older secret revisions
cannot replace a newer setting or deletion; metadata-first delivery at the same
revision remains supported. Acknowledged storage effects are not blindly
rolled back if cancellation happens while a store operation is in progress.

Credential-bearing configuration paths use their declared schema classification:
actual literal local credentials travel only as recipient-sealed values, never
as ordinary config entries. Receivers store them encrypted and set the canonical
local secret reference. Public credential metadata accepts only that exact
reference or the empty setting; unsupported machine-specific secret references
report guidance to use the encrypted credential setting. Incoming public literal
credentials are refused before they can enter config/replica storage. A credential
revision marker also cannot contain a raw value disguised as secret metadata.

Incoming authenticated group handlers admit at most 32 concurrent operations.
When that limit is occupied, additional datagrams are dropped before deferred
work is created; existing snapshot and periodic anti-entropy requests recover
loss. A value-free overload diagnostic is limited to once per minute. Entered
operations remain owned and drain on stop or membership change. Explicit
operator membership operations are outside this incoming traffic budget.
