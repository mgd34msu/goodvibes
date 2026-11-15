# Cluster operation outcomes

Creating, joining, rejoining and leaving reserve one operation per daemon. A second concurrent membership request returns `not-sent`; wait for the first operation before retrying. Shutdown cancels work that has not entered persistence and drains work already admitted before releasing its stores.

A membership change that has already received a successful storage acknowledgement finishes its matching roster record during shutdown. It does not re-enable the stopped daemon's signing keys.

`persistence-unknown` means a storage write or deletion started and its complete result could not be confirmed. The operation may have taken effect. GoodVibes disables live group authority and preserves the saved files; it does not retry the effect, restore old keys or claim that nothing changed. While sharing is on, the stored membership is read again every 30 seconds, exactly as a restart reads it, and the machine is back in its group as soon as the store answers; a restart reads it at once. Inspect `cluster status` and the membership store before deciding whether another operation is necessary. HTTP cluster refusals return status 409 with the structured `failure` field.

When a save of the group key during a rotation, a key sweep or the adoption of another machine's rotation is refused, the secrets store is read back once. If it holds the new key, the machine continues with it. If it still holds the previous key, the machine keeps that key and the save is tried again by the next pass; the cause is logged once when the failures start and again when a save succeeds. Only when the store cannot be read back is the membership reported as `unreadable-key-material`, recovered as above.

The member list file changes only when a machine is added or removed, the group is renamed or the group signing key is replaced. When each machine was last heard is kept in memory: `cluster nodes` shows it as `lastSeenAt`, with `heardSinceStart: false` for a machine nothing has been heard from since this daemon started listening.

A saved configuration replica is used only with its own group ID. Changing groups does not cause a previous group's replica to become the new group's configuration after restart.

The public group ID and join key remain compatible with released peers. Before their first authenticated JOIN, both peers derive the same 16-byte scrypt salt using the existing fixed public `goodvibes-join-salt-v1` HMAC representation. This label is public, contributes no secret entropy and does not provide anonymity. Normal membership, key rotation and live guards reuse stored material without repeating this salt derivation.

One member answers a join, so a join writes the roster once and sends one grant; a repeated join from a machine already on the roster is answered with the grant again. A join with a mistyped key is reported about two seconds after a member answers, as "a machine in that group answered and the join key did not match", instead of after the full wait. `cluster forget` records which join key the removed machine held; no member admits a join made with that key, so the removed machine cannot come back with it even before every member has the replacement join key.

Configuration transfers remain bound to the original live group and member generation across storage waits. Removing and re-adding a member, retiring the authenticated key generation, changing the group, or stopping the daemon prevents later writes or secret transmissions from that request. Ordinary heartbeat and display-name updates do not interrupt it. A write already entered before authority changes remains owned through completion; it is not blindly undone.

Group envelopes use a shared group key. These checks restrict the claimed sender against the current roster; they do not turn that shared key into an independent signature for each machine.

## Networks without multicast

Machines find each other over multicast by default. On a network that drops multicast, list the other machines under `cluster.peers`, a list setting like any other:

```sh
goodvibes-daemon config set cluster.peers '["10.0.0.2", "10.0.0.3:61860"]'
```

or in the daemon's settings file:

```json
{
  "cluster": {
    "enabled": true,
    "peers": ["10.0.0.2", "10.0.0.3:61860"]
  }
}
```

Each entry is a host or `host:port`; a host with no port uses `cluster.port`. List every other machine on every machine. The coordination log line "set cluster.peers" refers to this key.

The same applies to `conversationGate.gatedSurfaces`: a list of surface names (for example `["telegram", "slack"]`) whose inbound messages go through the conversation gate, set with `goodvibes-daemon config set conversationGate.gatedSurfaces '["telegram"]'`. An empty or missing list uses the shipped list of channel surfaces.

## Local configuration and credentials

The daemon subscribes to successful configuration and credential-store changes.
Only paths declared group-scoped by the platform policy are eligible; local
ports, transport identity, user preferences and unrelated provider credentials
stay on their original machine. A local configuration reset publishes its
resolved default; an explicit group deletion publishes a tombstone. Every
machine issues the revision for the changes made on it and sends them to the
group; no machine has to be in charge, so replication works whichever machines
hold surfaces. Explicitly setting a deleted setting again clears that deletion.

Every roster gossip carries a digest of the sender's shared settings. A machine
whose digest differs sends its own settings and asks the sender for its, so a
missed message or a healed network split ends with the same settings on both
sides; `cluster status` says "settings are being exchanged" until it does. A
machine that has just joined (or restarted) holds changes made on it until it
has the group's settings, then sends them, so it never overwrites the group with
what it had before. A local value that differs from a setting another machine
changed last is replaced with the group's value and logged; set it again to
change it for the whole group. One member, the same one on every machine,
answers a request for the full settings and a join.

Once a machine holds the group's settings, credentials stored on it that the
group has no record of are seeded once. Absent values do not become deletion requests, and
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
