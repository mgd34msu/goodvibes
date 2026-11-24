# Channels, remote access, and API

GoodVibes Agent can be reached from terminal-first and companion surfaces, but the Agent product does not own transport hosting. It connects to a GoodVibes host owned outside this package and uses public operator routes for status, sessions, artifacts, approvals, automation, and Agent Knowledge.

## Channel posture

Channel setup is explicit. Agent can inspect channel readiness, guide pairing, inspect recent redacted delivery receipts, and send one confirmed delivery message through configured strategies, including connected-host telephony targets, but it must not silently expose a new public surface or send messages to people without a user action.

Agent channel UX should show:

- which channels are enabled by the owning GoodVibes host;
- whether account/token setup is present without printing secret values;
- the default target, if configured;
- delivery risk and public exposure warnings;
- the ordered setup guide step for the next channel, including setup schema, secret-backed settings, allowlist policy, live status or doctor checks, and explicit test-send boundary;
- channel triage across setup blockers, daemon delivery attempts, visible control-plane surface messages, route bindings, and Agent receipts;
- recent confirmed-send receipts with webhook/link target values redacted and message previews bounded;
- the command or workspace action needed to pair companion clients through QR-first setup;
- the confirmed `Send channel message` action when the user explicitly wants a one-off delivery.

VIBE.md, project context files, Agent-local memory, routines, skills, and personas are not automatically broadcast to channels. External delivery is an effect and requires an exact command, an explicit routine promotion, or a user-approved connected-host request.

Device pairing uses `/devices pair device` (optional `--name <device name>`) or `goodvibes-agent pair`: the connected host mints a new named device token and the Agent shows its `#pair=` link and QR, the same pairing the TUI does. It first asks the host (`pairing.posture.get`) whether another device could open the code, which the host decides from its settings; when none could and the host runs on this machine, the token is minted for a browser on this machine instead (`This link signs in a browser on this computer. A phone cannot open it: <why>.`, the steps ending in the host-side command that fixes it, `goodvibes-daemon webui enable --lan`, then the link and the sign-in code, and no QR); when the host runs on another machine, no token is minted and the answer gives that command and why. The conversation keeps what it prints, so the link and the sign-in code are printed masked (the address readable, the code replaced: `http://<host>:3421/#pair=••••••••••••`), as one transcript block that ends with `Ctrl+Y copies the pairing link` (the block-copy key, as bound): that key on this block copies the real link to the clipboard (a clipboard program, or the terminal's OSC 52) and says which. When nothing reaches a clipboard and the block has no QR code (the link only this computer opens), the link is printed in clear once, saying why. `goodvibes-agent pair`, run in a shell, prints the link itself. The device appears in the host's device list and is revoked there on its own; the Agent's own host credential is never printed. Pairing gives a device access, so only the owner typing the command gets a link; the same command run by the model is refused. One-off delivery uses Agent Workspace -> Channels -> Send channel message or `/channels send ... --yes`; channel triage is visible through Agent Workspace -> Channels -> Channel triage or `/channels triage`, and recent receipts are visible through Delivery receipts or `/channels deliveries`.

The model can inspect pairing and device posture with `device action:"status"`, and inspect one pairing route with `device action:"capability"` using `capabilityId`, `pairingRouteId`, `target`, or `query`. Lower-level `agent_harness` modes `pairing_posture` and `pairing_route` remain available for detailed compatibility. Those routes return endpoint binding, pairing surface id, route catalog, token fingerprint, and companion device capability posture only; raw tokens and QR payloads are never returned by the read-only posture modes. Device pairing (`/devices pair device`), companion connection, channel delivery, task, approval, provider/model, and attachment actions stay visible user flows.

The model can inspect channel-facing workspace actions with `workspace action:"actions|action"`, but the preferred channel route is `channels action:"status|channel|setup|triage|deliveries"`. It lists the structured channel readiness map, inspects one channel, inspects channel triage, inspects recent redacted delivery receipts, and shows the ordered channel setup guide using `channelId`, `target`, or `query`.

Channel discovery is compact by default, and workspace action rows include `modelRoute` hints for send/setup actions. Use `includeParameters:true`, single-channel inspection, triage, the receipt ledger, or the setup guide when the model needs delivery target shape, read-only connected-route hints, current setup step, allowlist review route, live-check route, recent confirmed-send outcome ids, route-binding continuity, surface messages, or delivery retry candidates.

These actions are read-only. They return setup state, delivery posture, risk labels, safe config-key names, default-target key names, route ids, redacted/digested external ids, and redacted receipt summaries without printing secret values or sending messages.

`channels action:"triage"` reads `/api/deliveries`, `/api/control-plane/messages`, and `/api/routes/bindings` when the connected host is authenticated; it does not itself poll provider-specific Slack, Discord, or email inboxes. `agent_harness` mode `unified_inbox` is the aggregating read model that does: it folds that same triage data together with the daemon's own inbound feed (`channels.inbox.list`), including provider inbound messages, into one item list. When that feed is absent, the reported reason is the daemon's own observed answer: unreachable, unauthenticated, or the method not served. It is not a blanket "not published" claim.

The model can send one explicit configured delivery through `agent_channel_send` only when the user asks for that exact effect. Lower-level `agent_harness` channel modes remain compatibility/detail routes. `agent_review_packet_share` is the specialized confirmed route for sending a reviewer packet archive through a configured channel, a bound route or a webhook, with the ZIP attached where the surface carries attachments. A link target (`link` on `agent_channel_send`, `/channels send --link <name>`, `--delivery-link <name>` on a schedule) publishes the message or each scheduled result as a document on the host and shows its link on the owner's web surface; outside the host the receipt names the saved document. It must not create routes, authorize accounts, infer recipients, or expose new public surfaces from chat.

Saved channel drafts use `agent_harness` modes `channel_draft_save` and `channel_draft_send`. A draft moves from `draft` to `queued` when it is sent, then to `sent` or `failed` when delivery reports its outcome. A sent draft is final and a failed draft can be queued again. A draft is marked `queued` before anything is sent, and a queued draft is never queued again: while it reads `queued` its delivery is in progress or its outcome was not recorded, so it may already have been delivered. If the recipient did not get it, save the text as a new draft and send that.

The model can inspect configured notification target posture with `agent_harness` mode `notifications`, and inspect one redacted target with mode `notification_target` using `notificationTargetId`, `target`, or `query`. Notification discovery is compact by default, while `workspace action:"actions"` distinguishes direct `agent_notify` sends/tests from confirmed workspace routes for add/remove/clear management. Use `includeParameters:true` or single-target inspection when management route hints are needed.

These modes return target count, validity, protocol/host posture, and fingerprints, but not full webhook URLs. Use `agent_notify` for one explicit confirmed notification. Use confirmed `/notify` mirrors for target management only when the user supplies the exact add/remove/clear/test intent.

## Companion and session routes

Normal assistant chat uses companion chat routes. Build/fix/review delegation uses shared-session or task routes only when the user explicitly asks for implementation work.

Do not use shared coding sessions for ordinary chat. Do not start background automation for routine assistant work.

## Remote access

Remote-node and peer capability is owned by the connected GoodVibes host. In Agent, remote commands are read-only unless the user explicitly delegates build/fix/review work to GoodVibes TUI. The current Agent behavior should guide the user toward:

- inspecting remote support state;
- checking routes and peer readiness;
- delegating explicit build/fix/review work to GoodVibes TUI when remote execution is actually needed.

Agent should not start remote build hosts, manage peer lifecycle, or fan out separate Agent jobs from the main conversation.

## Public API use

Use public connected-host/operator routes only. For Agent Knowledge, the only valid family is:

```text
/api/goodvibes-agent/knowledge/*
```

If an Agent-specific route is missing, fail closed or show guidance. Do not substitute the default knowledge, another product segment, or private connected-host files. Normalize parseable public Agent-route scope aliases before rendering, and fail the call when the response carries known non-Agent contamination.

Harness and settings operations use the Agent-owned `agent_harness` tool. Generic settings/context mutators are not the model-facing Agent contract.

## Related docs

- [Getting started](getting-started.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Tools and commands](tools-and-commands.md)
