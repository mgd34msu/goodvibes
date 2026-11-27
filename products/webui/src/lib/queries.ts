export const queryKeys = {
  auth: ['auth'] as const,
  status: ['control', 'status'] as const,
  control: ['control', 'snapshot'] as const,
  accounts: ['accounts'] as const,
  providers: ['providers'] as const,
  // The daemon's full config tree (config.get): the ONE cache entry for it. The
  // generic settings rows, the model and price dialogs, the voice and wake hooks and
  // the session-view permission-mode reader all read and invalidate this key, so a
  // write from any screen is seen by every reader.
  config: ['config'] as const,
  // flags.status: restart-gated features whose saved setting the running daemon has
  // not applied yet. Re-read on a save of one of those settings and on a config frame.
  featureRestartStatus: ['flags', 'status'] as const,
  // Revision is local, contains no credentials, and changes on token/relay identity
  // replacement and expiry. The prefix lets contract events refresh every view.
  contracts: ['contracts'] as const,
  contractList: (revision: number, includeTerminal: boolean) => ['contracts', revision, 'list', includeTerminal] as const,
  contractDetail: (revision: number, id: string) => ['contracts', revision, 'detail', id] as const,
  tasks: ['tasks'] as const,
  // The project work plan, read again only when a planner event or an edit
  // carries a revision other than the one shown (hooks/useWorkPlan.ts).
  workPlan: ['work-plan'] as const,
  workPlanSnapshot: (revision: number, project: string | undefined) => ['work-plan', revision, project ?? ''] as const,
  approvals: ['approvals'] as const,
  // The owner inbox's questions and Jev's decisions (views/work/OwnerQuestions.tsx).
  ownerInbox: ['owner-inbox'] as const,
  // Durable approval rules (permissions.rules.list), remembered decisions at a
  // generalizing tier. Invalidate alongside approvals: a decision can mint a
  // rule, a deletion hands matching calls back to the permission mode.
  permissionRules: ['permissions', 'rules'] as const,
  sessions: ['sessions'] as const,
  sessionList: (revision: number) => ['sessions', 'list', revision] as const,
  // fleet.*/checkpoints.* (platform 0.39.0-dev). Neither verb family emits a wire
  // event yet (pinned by the platform's own fleet/checkpoints search test suite,
  // "none of these verbs declares a wire event"), so these are NOT wired into
  // useRealtimeInvalidation's DOMAIN_INVALIDATIONS map; FleetView/CheckpointsView
  // poll on an interval and expose a manual refresh instead. Revisit once a
  // fleet-update event (mentioned as a possibility in the platform's fleet/checkpoints
  // design notes) lands.
  fleet: ['fleet'] as const,
  // Session archive of finished fleet subtrees (fleet.archived.list), same
  // poll-not-push story as the live fleet key above.
  fleetArchived: ['fleet', 'archived'] as const,
  // Best-of-N held-merge attempt groups (fleet.attempts.list), same poll-not-push
  // story as the live fleet key above; 'fleet'-prefixed so a broad fleet invalidation
  // sweeps it too.
  fleetAttempts: ['fleet', 'attempts'] as const,
  checkpoints: ['checkpoints'] as const,
  // Workstream view rides fleet.* filtered to orchestration/workstream rows,
  // fill the body, do not restructure the key.
  workstream: ['workstream'] as const,
  // Detail + messages keys are PREFIXED with 'sessions' so that invalidating
  // queryKeys.sessions (non-exact) refetches the list AND every open detail/messages
  // query, the single invalidation the raw session-update stream fires.
  sessionDetail: (sessionId: string) => ['sessions', sessionId] as const,
  sessionMessages: (sessionId: string) => ['sessions', sessionId, 'messages'] as const,
  // Input receipts follow the same event invalidation, isolated by account/relay lifetime.
  sessionInputs: (revision: number, sessionId: string) => ['sessions', sessionId, 'inputs', revision] as const,
  // sessions.permissionMode.get / sessions.contextUsage.get (platform 1.6.1), same
  // 'sessions'-prefixed convention as sessionDetail/sessionMessages above, so
  // useRealtimeInvalidation's broad `queryKeys.sessions` invalidation (fired on every
  // 'permissions' domain frame, PERMISSION_MODE_CHANGED rides it) also revalidates
  // whichever session's mode/usage chip is currently mounted, without needing to know
  // which session that is at the point the frame arrives.
  sessionPermissionMode: (sessionId: string) => ['sessions', sessionId, 'permission-mode'] as const,
  sessionContextUsage: (sessionId: string) => ['sessions', sessionId, 'context-usage'] as const,
  // sessions.changes.get (platform 1.6.1), same 'sessions'-prefixed convention as
  // sessionPermissionMode/sessionContextUsage above. No wire event exists for this verb
  // yet (same standing gap fleet.*/checkpoints.* document elsewhere in this file), so
  // SessionChanges.tsx refetches manually rather than riding useRealtimeInvalidation;
  // the prefix still means it's swept by any broad `queryKeys.sessions` invalidation.
  sessionChanges: (sessionId: string) => ['sessions', sessionId, 'changes'] as const,
  // sessions.hosted.list (daemon-hosted sessions), the daemon-hosted session lifecycle
  // list, DELIBERATELY not 'sessions'-prefixed: hosted sessions have their own
  // lifecycle wire event (hosted-session-update, not session-update) and their own
  // realtime hook (useHostedSessionRealtime), so a broad `queryKeys.sessions`
  // invalidation is neither necessary nor sufficient to keep this fresh.
  hostedSessions: (includeTerminated: boolean) => ['hosted-sessions', 'list', includeTerminated] as const,
  // The un-parameterized prefix, for invalidating every includeTerminated variant at
  // once (non-exact invalidateQueries match), the same "prefix sweeps every variant"
  // convention queryKeys.sessions already documents for sessionDetail/sessionMessages.
  hostedSessionsAll: ['hosted-sessions'] as const,
  // cost.attribution.get (platform 1.6.1), keyed by window+dimension so switching either
  // refetches honestly rather than serving a stale slice from cache.
  costAttribution: (window: string, dimension: string) => ['cost', 'attribution', window, dimension] as const,
  knowledgeStatus: ['knowledge', 'status'] as const,
  knowledgeSources: ['knowledge', 'sources'] as const,
  knowledgeNodes: ['knowledge', 'nodes'] as const,
  knowledgeIssues: ['knowledge', 'issues'] as const,
  knowledgeMap: ['knowledge', 'map'] as const,
  knowledgeProjections: ['knowledge', 'projections'] as const,
  knowledgeRefinement: ['knowledge', 'refinement'] as const,
  // Activity honesty: the never-called knowledge.jobs.list /
  // knowledge.job-runs.list, read from the map/nodes "View jobs" link.
  knowledgeJobs: ['knowledge', 'jobs'] as const,
  // Consolidation candidates (knowledge.candidates.list/.candidate.get/.decide), a
  // never-called-before surface (like knowledgeJobs above) this brief adopts.
  knowledgeCandidates: ['knowledge', 'candidates'] as const,
  localAuth: ['local-auth'] as const,
  // Memory (memory.records.* / memory.review-queue, platform 1.1.0). No wire event exists
  // for this domain yet, so MemoryView polls/refetches manually rather than riding
  // useRealtimeInvalidation (same standing gap fleet.*/checkpoints.* document above).
  memoryList: ['memory', 'list'] as const,
  memoryCopies: ['memory', 'copies'] as const,
  memoryReviewQueue: ['memory', 'review-queue'] as const,
  // Calendar events are windowed by [from, to), keyed on the range plus an optional
  // logical calendarId filter so switching ranges/calendars refetches honestly rather
  // than serving a stale window from cache.
  calendarEvents: (from: string, to: string, calendarId: string) =>
    ['calendar', 'events', from, to, calendarId] as const,
  // The one-event read that answers "is a calendar connected": shared by the
  // account status in Settings and the new-chat starters.
  calendarProbe: ['calendar', 'surface-probe'] as const,
  // Whether a calendar is set up (the capability calendar.status), then the one-event read: the account box in Settings.
  calendarSetUp: ['calendar', 'surface-probe', 'set-up'] as const,
  // Whether the mailbox is set up and answers (the capability mail.status): the new-chat mail starter. A read that
  // answers either way, so a new chat with no mail set up asks nothing the daemon refuses.
  mailStatus: ['email', 'status'] as const,
  // The same capability's whole answer (reachable, and why not by the refusal's code): the mail account box in Settings.
  mailStatusDetail: ['email', 'status', 'detail'] as const,
  // email.*, the inbox listing is keyed on the filters that change what the daemon
  // fetches from IMAP (limit, unread-only, since), so toggling a filter refetches
  // rather than re-rendering a window that no longer matches the controls. No wire
  // event exists for this domain either, so MailView refetches manually, same
  // standing gap fleet.*/checkpoints.*/memory.*/calendar.* document.
  emailInbox: (limit: number, unreadOnly: boolean, since: string) =>
    ['email', 'inbox', limit, unreadOnly, since] as const,
  // Keyed per IMAP UID: the peek body for one message is its own cache entry, so
  // reopening a message already read is instant and closing does not evict the list.
  emailMessage: (uid: number) => ['email', 'message', uid] as const,
  // ci.* (platform 1.6.1's initiative family). No wire event exists for this domain yet, so
  // CiWatchesView polls/refetches manually rather than riding useRealtimeInvalidation,
  // same standing gap fleet.*/checkpoints.*/memory.* document above.
  ciWatches: ['ci', 'watches'] as const,
  // checkin.* (platform 1.6.1's initiative family). Same manual-refresh story as ci.* above.
  checkinConfig: ['checkin', 'config'] as const,
  checkinReceipts: ['checkin', 'receipts'] as const,
  // principals.* / channels.profiles.* (platform 1.6.1's initiative family). Same
  // manual-refresh story as ci.*/checkin.* above.
  principals: ['principals'] as const,
  channelProfiles: ['channels', 'profiles'] as const,
  // pairing.tokens.* (platform 1.8.0), per-device revocable pairing tokens. No wire event
  // exists for this domain yet, so PairingTokensSettings polls/refetches manually,
  // same standing gap fleet.*/checkpoints.*/memory.*/ci.* document above.
  pairingTokens: ['pairing', 'tokens'] as const,
  relayCodes: ['relay', 'codes'] as const,
  // remote.pair.requests.list: devices waiting to pair as a node. Re-read on the
  // remote-pair-requested/-approved/-rejected events (useRealtimeInvalidation).
  remotePairRequests: ['remote', 'pair', 'requests'] as const,
  // pairing.posture.get (platform 1.8.0's LAN-http posture work), the honest TLS/capability
  // posture of THIS surface's own origin. An origin's posture never changes within a
  // session (see useOriginPosture), so this is fetched once and never invalidated.
  originPosture: ['pairing', 'posture'] as const,
  // pairing.posture.get with no origin: the address a pairing code carries, and whether a
  // phone can open it (`reach`). Settings change it, so it is read each time the pairing
  // form is shown, never cached as the origin posture is.
  pairingAddress: ['pairing', 'address'] as const,
  // power.status.get / power.keepAwake.set (platform 1.8.0's host sleep-ownership work).
  // OPS_POWER_STATE_CHANGED rides the 'ops' runtime domain, useRealtimeInvalidation
  // invalidates this key on that frame, so the always-visible "sleep disabled" chip and
  // the admin Power panel both refetch on the real event, not only on the next poll.
  power: ['power', 'status'] as const,
  // ops.memory.get (platform 1.9.0-dev's memory-relay-voice-hardening work), the
  // MemoryGovernor's own observability snapshot. OPS_MEMORY_PRESSURE rides the same
  // 'ops' runtime domain OPS_POWER_STATE_CHANGED does, useRealtimeInvalidation
  // invalidates this key on that frame, so the panel refetches on the real tier
  // change/tripwire event, not only on the next poll.
  opsMemory: ['ops', 'memory'] as const,
  // voice.local.status (platform 1.9.0-dev), the managed local-voice runtime's own
  // provisioning state (piper TTS + whisper.cpp STT binaries/models on disk), distinct
  // from voice.status's provider-availability posture. No wire event exists for this
  // verb yet, so VoiceSettings refetches manually/on install-mutation success, same
  // standing gap fleet.*/checkpoints.*/memory.* document elsewhere in this file.
  voiceLocalStatus: ['voice', 'local', 'status'] as const,
  // companion.chat.queuedMessages.list. No wire event
  // exists for this verb yet, so the Composer's queued-messages panel refetches
  // manually/on mutation success, same standing gap fleet.*/checkpoints.*/memory.*
  // document elsewhere in this file.
  sessionQueuedMessages: (sessionId: string) => ['sessions', sessionId, 'queued-messages'] as const,
  // fleet.graph.get (platform 1.8.0's fix-phase workstream rework). No wire event exists for
  // this verb yet either, same standing gap. Keyed by workstreamId so switching the
  // selected workstream refetches honestly rather than serving a stale graph.
  fleetGraph: (workstreamId: string) => ['fleet', 'graph', workstreamId] as const,
  // tailscale.get (platform 1.8.0's LAN-http posture work), the read-only environment
  // probe behind the one-action "Serve over tailscale" affordance. No wire event
  // exists for this verb yet, so TailscaleSettings polls/refetches manually, same
  // standing gap pairingTokens/fleetGraph document above.
  tailscale: ['tailscale', 'get'] as const,
  // cloudflare.status: no wire event; CloudflareSettings refetches after its own disable.
  cloudflare: ['cloudflare', 'status'] as const,
  // memory.consolidation.receipts (platform 1.8.0), retained consolidation run receipts
  // + pending judgment proposals. No wire event exists for this verb yet either,
  // same standing gap; the panel refetches manually/on demand.
  memoryConsolidationReceipts: ['memory', 'consolidation', 'receipts'] as const,
  // profile.* (docs/owner-profile.md §11.1), the owner profile document, its load
  // state, and per-line provenance. No wire event exists for this domain, so
  // OwnerProfileSettings refetches on its own mutations, same standing gap
  // pairingTokens/tailscale/fleetGraph document above.
  //
  // These entries hold profile CONTENT in react-query's in-memory cache for the life of
  // the page and nowhere else: this app installs no query-cache persister (mount-app.tsx
  // constructs a plain QueryClient), so nothing here outlives the session, which is what
  // §11.3's containment rule requires of this surface.
  ownerProfile: ['owner-profile', 'document'] as const,
  ownerProfileStatus: ['owner-profile', 'status'] as const,
  // Keyed per target so each line's "where did you get that" is its own cache entry,
  // provenance is reachable per line, never as one bulk dump (§8.3).
  ownerProfileProvenance: (targetId: string) => ['owner-profile', 'provenance', targetId] as const,
  // One profile field read on its own (the account menu's owner name). Under the
  // owner-profile prefix so every profile edit's prefix invalidation refreshes it.
  ownerProfileField: (path: string) => ['owner-profile', 'field', path] as const,
  // occasions.* (docs/occasions.md), the dates panel. No wire event exists for this
  // domain yet, so DatesView refetches manually/on mutation success, same standing
  // gap fleet.*/checkpoints.*/memory.*/ci.*/checkin.* document above.
  occasionsList: ['occasions', 'list'] as const,
  occasionsPending: ['occasions', 'pending'] as const,
  occasionsPlansList: ['occasions', 'plans', 'list'] as const,
  occasionsState: ['occasions', 'state'] as const,
  // Keyed per occasion so each one's gift history is its own cache entry, reachable
  // from the peek without evicting the upcoming-occasions list.
  occasionsGifts: (occasionId: string) => ['occasions', 'gifts', occasionId] as const,
};

/**
 * How a list the daemon sends no change event for stays current without a click:
 * read again each time its view is opened and when the window or tab regains
 * focus, keeping the rows on screen until the fresh answer arrives. The app's
 * default leaves focus re-reads off (a re-read that costs a model call or money
 * must never run on focus); these reads cost neither. When a list gains an
 * event, the event moves it and this stays as the fallback.
 */
export const NO_EVENT_LIST_FRESHNESS = { refetchOnMount: 'always', refetchOnWindowFocus: true, refetchOnReconnect: true } as const;

