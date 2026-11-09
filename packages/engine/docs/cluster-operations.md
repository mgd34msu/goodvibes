# Cluster operation outcomes

Creating, joining, rejoining and leaving reserve one operation per daemon. A second concurrent membership request returns `not-sent`; wait for the first operation before retrying. Shutdown cancels work that has not entered persistence and drains work already admitted before releasing its stores.

A membership change that has already received a successful storage acknowledgement finishes its matching roster record during shutdown. It does not re-enable the stopped daemon's signing keys.

`persistence-unknown` means a storage write or deletion started and its complete result could not be confirmed. The operation may have taken effect. GoodVibes disables live group authority and preserves the saved files; it does not retry the effect, restore old keys or claim that nothing changed. Inspect `cluster status` and the membership store, then restart to reconcile saved membership before deciding whether another operation is necessary. HTTP cluster refusals return status 409 with the structured `failure` field.

A saved configuration replica is used only with its own group ID. Changing groups does not cause a previous group's replica to become the new group's configuration after restart.

The public group ID and join key remain compatible with released peers. Before their first authenticated JOIN, both peers derive the same 16-byte scrypt salt using the existing fixed public `goodvibes-join-salt-v1` HMAC representation. This label is public, contributes no secret entropy and does not provide anonymity. Normal membership, key rotation and live guards reuse stored material without repeating this salt derivation.

Configuration transfers remain bound to the original live group and member generation across storage waits. Removing and re-adding a member, retiring the authenticated key generation, changing the group, or stopping the daemon prevents later writes or secret transmissions from that request. Ordinary heartbeat and display-name updates do not interrupt it. A write already entered before authority changes remains owned through completion; it is not blindly undone.

Group envelopes use a shared group key. These checks restrict the claimed sender against the current roster; they do not turn that shared key into an independent signature for each machine.
