/**
 * method-risk.ts, the risk class of every builtin daemon method: what calling it does that the owner decides, in the
 * capability layer's own words (capabilities/command-line-hold.ts). The daemon's dispatch reads it once for every call
 * (daemon/method-owner-decision.ts): a method of a class other than `none`, called by anyone but the owner's own
 * program with a person's press, is decided as the capability that does the same act would be (put to the owner,
 * opening on No, or decided under the owner's mode); a no-risk method is admitted by its effects alone, as before.
 *
 *   - `loosens-a-protection`: weakens a protection, or installs something that runs by itself with no decision at its
 *     runs (a tool server, a system service);
 *   - `runs-later`: sets something to run by itself later whose runs are decided under the mode each time (a schedule, a
 *     trigger, a watcher, a job): decided as a change under the owner's mode (a judgment), as 3.5.0 decided a model's
 *     schedule or trigger, never as a loosened protection;
 *   - `steers-a-model`: writes what steers a model in the owner's turns (a memory record, a profile fact, a skill), the
 *     capability layer's `steersModel` (capabilities/types.ts): the owner's own program writes it as theirs (their press, or
 *     their model in their own conversation, kept with its author); anyone else's write is decided as the capability's;
 *   - `cannot-be-undone`: deletes or ends what nothing restores;
 *   - `spends-money`: a purchase, a batch of metered model work, a budget raised;
 *   - `writes-a-secret`: stores a credential, a key or a card;
 *   - `owner-act`: an act only the owner makes in person: refused for anyone but the owner in person (their verified program
 *     or their signed-in session; daemon/method-owner-decision.ts `makesOwnerOnlyAct`), in every mode, before the
 *     permission manager is reached, and never put to them as a question; their own model in their own turn makes it under
 *     their mode unless it is one a model never makes (`MODEL_NEVER_CAPABILITY_IDS`, the effect table's `modelRefused`).
 *     Everything by which a caller could become the owner, widen what it or anyone holds, or run code as the owner outside a
 *     project: sign-ins and passwords, credentials and pairings, who reaches what, secrets, the permission rules,
 *     managed locks, the machine group, the daemon's own process and its updates, tool servers, hooks, plugins and
 *     skills of no project;
 *   - `answers-the-owner`: answers something addressed to the owner (an approval, an inbox question, a plan, a device
 *     or a machine waiting to pair, a held channel message, a purchase window, a rewind request, a tidying proposal):
 *     answered by the owner or refused, never itself put to the owner (method-owner-decision.ts `ownerAnswers`). The one list of
 *     answers is this class (`ANSWER_METHOD_IDS`); a capability that answers is one whose method is of it, and a call of
 *     this class nested in any other run is refused unless that run's caller was admitted as the owner answering;
 *   - `none`: none of these.
 *
 * Declared here, by id, for every method that changes something; a read (every scope it needs is a read scope) is
 * `none` by what it declares. Where a capability runs the method by its id (capabilities/builtin/method-capability.ts,
 * an action's `operator.method`), the class here is that capability's own risk (its owner-only flag is `owner-act`;
 * `sends-out` is `none` here: a send is decided by its recipients, not by this rule). `methodDescriptor` stamps the
 * class on the descriptor and stops the catalog from loading when a method that changes something has none, as an
 * undeclared `repeat` does. Pure data: no I/O.
 */

/** What calling a method does that the owner decides; `none` for anything else. */
export type MethodRisk = 'none' | 'loosens-a-protection' | 'runs-later' | 'steers-a-model' | 'cannot-be-undone' | 'spends-money' | 'writes-a-secret' | 'owner-act' | 'answers-the-owner';

export const METHOD_RISKS: readonly MethodRisk[] = ['none', 'loosens-a-protection', 'runs-later', 'steers-a-model', 'cannot-be-undone', 'spends-money', 'writes-a-secret', 'owner-act', 'answers-the-owner'];

const L = 'loosens-a-protection' as const;
const R = 'runs-later' as const;
const T = 'steers-a-model' as const;
const U = 'cannot-be-undone' as const;
const M = 'spends-money' as const;
const S = 'writes-a-secret' as const;
const O = 'owner-act' as const;
const A = 'answers-the-owner' as const;
const N = 'none' as const;

/** Every builtin method that changes something, with its class. */
const DECLARED: Readonly<Record<string, MethodRisk>> = {
  // Work and the work ledger: approving a plan hands work over, the owner's own act.
  'work.plan.redo': N, 'work.plan.step.edit': N, 'work.plan.step.drop': N, 'work.plan.step.move': N,
  'work.plan.approve': A, 'work.plan.discard': N,
  // An ended work's kept branch: merging it in puts its commits in the project; discarding it deletes them.
  'work.branch.merge': N, 'work.branch.discard': U,
  'workLedger.execution.start': N, 'workLedger.execution.status': N, 'workLedger.execution.cancel': N, 'workLedger.execution.resume': N,
  'workLedger.submit': N, 'workLedger.submission.get': N,
  'workLedger.intake.capture': N, 'workLedger.intake.get': N, 'workLedger.intake.admit': N, 'workLedger.intake.resume': N, 'workLedger.intake.cancel': N,
  // Telegram handed in by another machine: who may reach this daemon there, and the owner's answers to it.
  'inbound.telegram.configure': O, 'inbound.telegram.decide': A, 'inbound.telegram.status': N, 'inbound.telegram.read': O,
  'inbound.telegram.list': N, 'inbound.telegram.cancel': O, 'inbound.telegram.revoke': O, 'inbound.telegram.release': O,
  'workLedger.turn.start': N, 'workLedger.turn.startAgent': N, 'workLedger.turn.status': N, 'workLedger.turn.cancel': N,
  // Signing in and out.
  'control.auth.login': N, 'control.auth.logout': N, 'control.auth.current': N,
  // Sessions. A looser permission mode is held by its own handler (SELF_HELD below).
  'sessions.create': N, 'sessions.register': N, 'sessions.checkpoints.changed': N, 'sessions.close': N, 'sessions.reopen': N,
  'sessions.detach': N, 'sessions.delete': U, 'sessions.permissionMode.set': L, 'sessions.messages.create': N, 'sessions.steer': N,
  'sessions.followUp': N, 'sessions.inputs.cancel': N, 'sessions.inputs.deliver': N,
  'tasks.create': N, 'tasks.cancel': N, 'tasks.retry': N,
  // Approvals: answering what was put to the owner.
  'approvals.raise': N, 'approvals.claim': N, 'approvals.approve': A, 'approvals.deny': A, 'approvals.cancel': N,
  'sessions.turns.cancel': N, 'sessions.toolCalls.cancel': N, 'sessions.queuedMessages.edit': N, 'sessions.queuedMessages.delete': N,
  // Hosted sessions: sharing one gives another principal its conversation.
  'sessions.hosted.create': N, 'sessions.hosted.attach': N, 'sessions.hosted.detach': N, 'sessions.hosted.kill': U,
  'sessions.hosted.share': L, 'sessions.hosted.unshare': N,
  'power.keepAwake.set': N,
  // Devices (device.capture, device.delete-capture, device.revoke-grant). A picture, the screen, the location or the
  // clipboard of the owner's phone, and reading or deleting a capture, are the owner's own acts (flat, every mode; by the
  // capability asked, BY_CALL below); the list is the owner's alone (record-addresses.ts, an owner-only list).
  'devices.capability.request': N, 'devices.artifacts.list': N, 'devices.artifacts.read': O, 'devices.artifacts.delete': O,
  'devices.grants.revoke': N, 'devices.housekeeping.run': N,
  // Memory: restoring a snapshot replaces what the owner keeps (memory.restore, the owner's own act).
  'memory.consolidation.decide': A, 'memory.snapshots.restore': O,
  // Voice: installing a local model is software that runs here as the owner, for every project: the owner's own act.
  'voice.local.install': O, 'voice.setup': N, 'voice.wake.provision': N,
  // Web chat.
  'companion.chat.sessions.create': N, 'companion.chat.sessions.update': N, 'companion.chat.sessions.close': N,
  'companion.chat.sessions.reopen': N, 'companion.chat.sessions.delete': U, 'companion.chat.messages.create': N,
  'companion.chat.messages.retry': N, 'companion.chat.messages.edit': N, 'companion.chat.branches.switch': N,
  'companion.chat.messages.steer': N, 'companion.chat.turns.cancel': N, 'companion.chat.queuedMessages.edit': N,
  'companion.chat.queuedMessages.delete': N, 'companion.chat.attachments.remove': U,
  // Automation: a job or a schedule runs by itself later (schedule.add, schedule.change, schedule.resume).
  'automation.jobs.create': R, 'automation.jobs.update': R, 'automation.jobs.delete': U, 'automation.jobs.enable': R,
  'automation.jobs.disable': N, 'automation.jobs.run': N, 'automation.runs.cancel': U, 'automation.runs.retry': N,
  'automation.heartbeat.run': N, 'automation.schedules.create': R, 'automation.schedules.delete': U, 'automation.schedules.resume': R,
  'automation.schedules.pause': N, 'automation.schedules.run': N,
  // Route bindings send a channel's messages into a conversation.
  'routes.bindings.create': L, 'routes.bindings.update': L, 'routes.bindings.delete': U,
  // Fleet, checkpoints, contracts. A raised budget lets a contract spend more.
  'fleet.archive': N, 'fleet.unarchive': N, 'fleet.archiveFinished': N, 'fleet.attempts.pick': N, 'fleet.attempts.judge': N,
  'fleet.observed.steer': N, 'fleet.conflicts.resolve': N, 'fleet.conflicts.retry': N,
  'checkpoints.create': N, 'checkpoints.restore': N, 'checkpoints.revertHunk': N,
  'fleet.stop': N, 'fleet.interrupt': N, 'fleet.resume': N,
  'contracts.start': N, 'contracts.dispatch': N, 'contracts.cancel': N, 'contracts.reply': A, 'contracts.remove': U,
  // A contract's budget raised is a spending limit raised: the owner's own act.
  'contracts.retryUnit': N, 'contracts.budget': O,
  'judgment.battery.run': N,
  // Channels: signing an account in, authorizing a surface, its allowlist and its rules decide who reaches the owner
  // (channels.set-rules): the owner's own acts, a caller giving a sender a way in to the owner.
  'channels.accounts.action.default': O, 'channels.accounts.action.named': O, 'channels.tools.invoke': N, 'channels.actions.invoke': N,
  'channels.targets.resolve': N, 'channels.authorize': O, 'channels.allowlist.resolve': N, 'channels.allowlist.edit': O,
  'channels.policies.update': O,
  // Watchers run by themselves later.
  'watchers.create': R, 'watchers.update': R, 'watchers.delete': U, 'watchers.start': R, 'watchers.stop': N, 'watchers.run': N,
  // The daemon's own process: installing its system service (it starts by itself at boot, as the owner), starting,
  // stopping, restarting or removing it are the owner's own acts.
  'services.install': O, 'services.start': O, 'services.stop': O, 'services.restart': O, 'services.uninstall': O,
  'channels.inbox.applyLabels': N, 'channels.inbox.triage': N, 'channels.routing.assign': N, 'channels.routing.delete': U,
  'channels.drafts.save': N, 'channels.drafts.delete': U,
  'homeassistant.conversation.submit': N, 'homeassistant.conversation.stream': N, 'homeassistant.conversation.cancel': N,
  // Triggers (triggers.watch, triggers.restart run by themselves later; triggers.stop cannot be undone).
  // A command a trigger may run is a grant of what runs as the owner: the owner's own act.
  'watchers.triggers.create': R, 'watchers.triggers.cancel': U, 'watchers.triggers.reset': R, 'watchers.triggers.grant.register': O,
  'channels.test.send': N,
  // The permission rules are the owner's own.
  'permissions.rules.delete': O,
  'inbox.answer': A, 'inbox.post': N, 'inbox.withdraw': N, 'inbox.delivery': N,
  'notifications.send': N, 'notifications.deadLetters.replay': N,
  'email.draft.create': N, 'email.draft.update': N, 'email.send': N, 'email.inbox.update': N, 'email.expectation.open': N,
  'email.expectation.cancel': N,
  // Payments.
  // Approving or denying a purchase window answers what was put to the owner (it spends only on the owner's own answer).
  'payments.purchase.reconcile': O, 'payments.purchase.securityCode': O, 'payments.purchase.approve': A, 'payments.purchase.deny': A,
  // A card is the owner's to enter and remove; a standing allowance raises what may be spent without them (their own model's
  // turn makes it under their mode, method-owner-decision.ts).
  'payments.purchase.cancel': N, 'payments.cards.create': S, 'payments.cards.delete': O, 'payments.checkout.approve': A,
  'payments.standing.create': O, 'payments.standing.delete': N, 'payments.checkout.begin': M,
  // Calendar (calendar.delete cannot be undone).
  'calendar.events.create': N, 'calendar.events.update': N, 'calendar.events.delete': U, 'calendar.ics.import': N,
  'browser.provision': N, 'browser.sessions.launch': N, 'browser.sessions.attach': N, 'browser.sessions.release': N,
  'browser.sessions.close': N, 'browser.navigate': N, 'browser.click': N, 'browser.type': N, 'browser.select': N, 'browser.press': N,
  'browser.scroll': N, 'browser.tabs.create': N, 'browser.tabs.switch': N, 'browser.tabs.close': N, 'browser.history.back': N,
  'browser.history.forward': N,
  // Tool servers run as the owner: one of no project (the global config) added or removed (BY_CALL below), and the trust,
  // role and unblocked or exempted tools of any server, are the owner's own acts; a project's own server is its project's.
  'mcp.servers.upsert': L, 'mcp.servers.remove': U, 'mcp.servers.tools.block': N, 'mcp.servers.tools.unblock': O,
  'mcp.servers.tools.exempt': O, 'mcp.servers.tools.unexempt': N, 'mcp.servers.trust.set': O, 'mcp.servers.role.set': O,
  'mcp.servers.reload': N, 'mcp.servers.quarantine.accept': O,
  // Reading out the tool servers' stored secret values (their environment and request headers) is the user's own read from
  // every credential of theirs: no class; the scope list of a credential still limits who reaches it.
  'mcp.servers.reveal': N,
  // Remote peers and the machine group (devices.approve and devices.reject answer the owner).
  'remote.pair.requests.approve': A, 'remote.pair.requests.reject': A, 'remote.peers.token.rotate': O, 'remote.peers.token.revoke': O,
  'remote.peers.disconnect': O, 'remote.peers.invoke': N, 'remote.backends.register': O, 'remote.backends.remove': O,
  'remote.work.cancel': N,
  'worktrees.setup.run': N, 'worktrees.discard': U,
  // Memory records steer the owner's turns (the capability layer's `steersModel`).
  'memory.vector.rebuild': N, 'memory.embeddings.default.set': N, 'memory.records.add': T, 'memory.records.update-review': T,
  'memory.records.delete': U, 'memory.records.import': T, 'memory.records.update': T, 'memory.records.links.add': T,
  // Models and providers (a subscription sign-in, begun or finished, was a judgment of a model's call at v3.5.0, class none; an API
  // key is a secret).
  'models.current.set': N, 'models.refresh': N, 'providers.subscription.signIn.begin': N, 'providers.subscription.signIn.finish': N,
  'providers.apiKey.set': S,
  // Batches spend provider money.
  'batch.jobs.create': M, 'batch.jobs.cancel': N, 'batch.providerBatches.cancel': N, 'batch.run': M,
  // Cloudflare (cloudflare.create-token and cloudflare.provision are the owner's own acts).
  'cloudflare.token.create': O, 'cloudflare.provision': O, 'cloudflare.disable': O,
  // A check installs a release it finds and restarts the daemon into it: the owner's own act.
  'update.check': O,
  // The relay (a relay code revoked withdraws a way in).
  'relay.pairing.mint': O, 'relay.codes.revoke': O,
  // Knowledge: a saved schedule runs by itself; importing the browser history is the owner's own act.
  'knowledge.issue.review': N, 'knowledge.ingest.url': N, 'knowledge.ingest.bookmarks': N, 'knowledge.ingest.urls': N,
  'knowledge.ingest.connector': N, 'knowledge.ingest.artifact': N, 'knowledge.ingest.browserHistory': O, 'knowledge.ask': N,
  'knowledge.candidate.decide': A, 'knowledge.refinement.run': N, 'knowledge.refinement.task.cancel': N,
  'knowledge.schedule.save': L, 'knowledge.schedule.delete': U, 'knowledge.schedule.enable': L, 'knowledge.job.run': N,
  'knowledge.job-run.cancel': N, 'knowledge.lint': N, 'knowledge.reindex': N, 'knowledge.projection.materialize': N,
  // A GraphQL mutation reaches every knowledge mutation, a schedule saved or switched on (runs by itself) and one deleted
  // among them: the most careful of those classes, as the schedule methods have.
  'knowledge.graphql.mutate': L,
  'projectPlanning.decisions.record': N, 'projectPlanning.workPlan.task.create': N, 'projectPlanning.workPlan.task.update': N,
  'projectPlanning.workPlan.task.status': N, 'projectPlanning.workPlan.tasks.reorder': N, 'projectPlanning.workPlan.task.delete': N,
  'projectPlanning.workPlan.clearCompleted': N,
  'homeassistant.homeGraph.syncHomeGraph': N, 'homeassistant.homeGraph.ingestHomeGraphUrl': N,
  'homeassistant.homeGraph.ingestHomeGraphNote': N, 'homeassistant.homeGraph.ingestHomeGraphArtifact': N,
  'homeassistant.homeGraph.linkHomeGraphKnowledge': N, 'homeassistant.homeGraph.unlinkHomeGraphKnowledge': N,
  'homeassistant.homeGraph.askHomeGraph': N, 'homeassistant.homeGraph.reindex': N, 'homeassistant.homeGraph.refreshDevicePassport': N,
  'homeassistant.homeGraph.generateRoomPage': N, 'homeassistant.homeGraph.generateHomeGraphPacket': N,
  'homeassistant.homeGraph.reviewHomeGraphFact': N, 'homeassistant.homeGraph.refinement.run': N,
  'homeassistant.homeGraph.refinement.task.cancel': N, 'homeassistant.homeGraph.import': N, 'homeassistant.homeGraph.reset': U,
  'voice.tts': N, 'voice.tts.stream': N, 'voice.stt': N, 'voice.realtime.session': N, 'web_search.query': N, 'artifacts.create': N,
  // A provider's media job is paid for when it is accepted (media.make, its capability, spends money); collecting one
  // pays nothing new.
  'media.analyze': N, 'media.transform': M, 'media.generate': M, 'media.collect': N, 'multimodal.analyze': N, 'multimodal.writeback': N,
  // Sign-ins: who may sign in, and with what, is the owner's to give.
  'local_auth.users.create': O, 'local_auth.users.scopes.set': O, 'local_auth.users.delete': O, 'local_auth.users.password.rotate': O,
  'local_auth.sessions.delete': O, 'local_auth.bootstrap.delete': O,
  'panels.open': N,
  // The owner's secrets are written and removed by the owner alone.
  'credentials.set': S, 'credentials.delete': O,
  // Settings: a change that loosens is decided by the settings route itself, by the value (VALUE_DECIDED below): for
  // anyone but the owner in person it is refused there, the owner's own act.
  'config.set': L, 'config.setMany': L, 'config.reset': L,
  'push.subscriptions.create': N, 'push.subscriptions.reconcile': N, 'push.subscriptions.delete': N, 'push.subscriptions.verify': N,
  // Pairing: a credential minted for someone (a migration included: it mints a credential of full authority), a
  // hand-off made, the operator token withdrawn. The daemon's own migration at an upgrade is its own act (the system).
  'pairing.tokens.create': O, 'pairing.tokens.rename': N, 'pairing.tokens.delete': U, 'pairing.tokens.migrate': O,
  // A hand-off completed is the device the owner just paired taking what the owner's own hand-off offered that very pairing
  // (its notifications, its passkey, once): confined to that offer by its handler, nothing widened.
  'pairing.tokens.revokeShared': O, 'pairing.handoff.create': O, 'pairing.serve.network': O, 'pairing.handoff.complete': N,
  // The outside agent's own credential: a pairing with full operator authority (daemon/outside-agent.ts), issued once per
  // daemon to the operator token on this machine (`mcp serve`). It holds what that token holds, so nothing is asked.
  'pairing.outsideAgent.issue': N,
  // Serving the daemon beyond this machine widens who reaches it: the owner's own act.
  'tailscale.serve.run': O, 'tailscale.serve.stop': N,
  // A new certificate authority is a new credential every phone is told to trust (and the old one's trust ends): the owner's
  // own act. A new server certificate under the same authority widens nothing.
  'secureAddress.set': S, 'secureAddress.reissue': N, 'secureAddress.replaceAuthority': O, 'secureAddress.serve': O,
  // The capability methods decide each call themselves (routes/capabilities.ts); the program's posts change nothing of the owner's.
  'capabilities.run': N, 'hooks.trace.post': N, 'context.windows.learned.post': N, 'permissions.audit.post': N,
  // Another coding agent, long-running, that runs its own tools under its own rules (agents.host, its capability).
  'acp.sessions.create': L,
  // Skills are the owner's, read by every project's turns: the owner's own acts.
  'skills.create': O, 'skills.update': O, 'skills.delete': O,
  'principals.create': O, 'principals.update': O, 'principals.delete': O,
  // A fact about the owner keeps no author to wait under (as a memory record does): anyone else's write is put to the owner in
  // every mode, as the About you capabilities are (their `ownerOnly`); the Agent's profile tool keeps its native admission.
  'profile.set': O, 'profile.append': O, 'profile.forget': O, 'profile.undo': O,
  // The owner's own reply to a nudge (yes, no, later, in hand) and to a gift question: the owner's own act. Their model in their own
  // turn records it under their mode, by its native admission (as the profile's); anyone else's is put to the owner.
  'occasions.propose': N, 'occasions.confirm': N, 'occasions.remove': U, 'occasions.update': N, 'occasions.answer': O,
  'occasions.acknowledge': O, 'occasions.interview.answer': O, 'occasions.interview.record': N, 'occasions.sweep': N,
  'occasions.conflict.resolve': N, 'occasions.plans.propose': N, 'occasions.plans.confirm': N, 'occasions.plans.update': N,
  'occasions.plans.remove': U,
  // A channel's profile sets the mode its sessions run under: a looser one is held by its own handler (SELF_HELD).
  'channels.profiles.set': L, 'channels.profiles.delete': N,
  'checkin.config.set': N, 'checkin.run': N,
  'ci.watches.create': N, 'ci.watches.delete': U, 'ci.watches.run': N,
  'rewind.apply': N, 'rewind.undo': N, 'rewind.conversation.host.register': N, 'rewind.conversation.host.release': N,
  'rewind.conversation.hosts.list': N, 'rewind.conversation.requests.take': N, 'rewind.conversation.requests.answer': A,
  // Registering a workspace lets callers name it as their project.
  'workspaces.registrations.add': O, 'workspaces.registrations.remove': N,
  'stepup.credentials.register': S, 'stepup.credentials.remove': O,
  // A step-up challenge is the one-time half of the owner's passkey proof, kept in a bounded table until answered or
  // expired: minting one is the owner's own act (another caller's mints would fill the table, STEP_UP_CHALLENGES_FULL, and
  // leave the owner no step-up), never a read.
  'stepup.challenge.mint': O,
};

/**
 * The methods that answer something addressed to the owner: exactly those of class `answers-the-owner` above, so the
 * list cannot miss one a new method declares.
 */
export const ANSWER_METHOD_IDS: ReadonlySet<string> = new Set(Object.entries(DECLARED).filter(([, risk]) => risk === A).map(([id]) => id));

/**
 * Methods whose class depends on a value only their handler reads (a settings write that loosens, a looser permission
 * mode, a channel profile's looser mode, revoking a device someone else paired). The dispatch tells the handler whether
 * the caller is one the rule admits at once (daemon/method-owner-decision.ts `callerAdmitted`, the same rule); a
 * handler that finds the value is one the owner decides, for a caller it does not admit, answers `OWNER_DECISION_NEEDED`
 * (method-owner-decision.ts `ownerDecisionNeeded`), and the dispatch then puts that one call to the owner's gate as
 * every other held method call. One rule, one gate, decided once; no handler holds a call itself.
 */
export const VALUE_DECIDED_METHOD_IDS: ReadonlySet<string> = new Set([
  'config.set', 'config.setMany', 'config.reset', 'sessions.permissionMode.set', 'channels.profiles.set',
  'channels.profiles.delete', 'pairing.tokens.delete',
]);

/**
 * The methods that make something run by itself later: a schedule or a schedule switched back on, a trigger, a watcher,
 * an agent task, a piece of work or a contract started, a saved knowledge schedule, a CI watch, a hosted session, a
 * channel route that sends a channel's messages into a conversation, a batch of model work. Whatever their class, a
 * model's call of one is never run unasked from what its turn read (text anyone can write: a page, a message, a file):
 * asked in every mode, each time (permissions/manager.ts `callFacts`), as the capabilities that make the same things are
 * (`RUNS_LATER_CAPABILITY_IDS`).
 */
export const RUNS_LATER_METHOD_IDS: ReadonlySet<string> = new Set([
  'automation.jobs.create', 'automation.jobs.update', 'automation.jobs.enable', 'automation.schedules.create', 'automation.schedules.resume',
  'watchers.create', 'watchers.update', 'watchers.start', 'watchers.triggers.create', 'watchers.triggers.reset', 'watchers.triggers.grant.register',
  'tasks.create', 'tasks.retry', 'contracts.start', 'contracts.dispatch', 'contracts.retryUnit',
  'workLedger.execution.start', 'workLedger.execution.resume', 'workLedger.submit', 'workLedger.intake.admit', 'workLedger.intake.resume',
  'workLedger.turn.start', 'workLedger.turn.startAgent', 'work.plan.approve',
  'knowledge.schedule.save', 'knowledge.schedule.enable', 'ci.watches.create', 'routes.bindings.create', 'routes.bindings.update',
  'batch.jobs.create', 'batch.run', 'sessions.hosted.create',
]);

/**
 * The capabilities that make something run by itself later (see `RUNS_LATER_METHOD_IDS`). A capability run through one
 * of those methods (its `method`) is one too, read from its entry where a gate's definition is built.
 */
export const RUNS_LATER_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'schedule.add', 'schedule.change', 'schedule.resume', 'triggers.watch', 'triggers.restart', 'triggers.allow-command',
  'work.daemon-task-add', 'work.start', 'work.delegate', 'work.resume', 'work.retry', 'work.go-on-without', 'work.approve',
  'ci.watch', 'hosted.new', 'agents.host', 'remote.dispatch', 'remote.dispatch-pool', 'routines.enable', 'routines.start',
]);

/**
 * The few methods whose class depends on what the call carries: the class of this call, from its body (minting a
 * credential of any client kind, the Agent's included, is the owner's own act whatever it carries; the Agent's
 * credential is made only for the owner in person, daemon/method-owner-decision.ts `mintsAgentCredential`):
 *   - `checkin.config.set`: switched on, it puts the check-in job on the scheduler (it runs by itself), and a delivery
 *     channel named sends the owner's briefings there: both loosen; quiet hours or cadence alone do not;
 *   - `ci.watches.create`: with a fix session on a failure, a failure later starts a session that spends model time (as
 *     the ci.watch capability's "Also start a fix session" choice says); a watch that only tells spends nothing.
 */
const BY_CALL: Readonly<Record<string, (body: Readonly<Record<string, unknown>>) => MethodRisk>> = {
  'checkin.config.set': (body) => body['enabled'] === true || (typeof body['deliveryChannel'] === 'string' && body['deliveryChannel'].trim() !== '') ? L : N,
  'ci.watches.create': (body) => body['triggerFixSession'] === true ? M : N,
  // A tool server of no project (the global config) runs as the owner in every project: added or removed, the owner's own act;
  // a project's own server is that project's (a caller works only in a project the owner gave it).
  'mcp.servers.upsert': (body) => body['scope'] === 'project' ? L : O,
  'mcp.servers.remove': (body) => body['scope'] === 'project' ? U : O,
  // The owner's phone: a picture, the screen, the location or the clipboard is the owner's own act (anyone else is refused, flat);
  // a notification, a link or a vibration is not. A capability this table cannot read is the owner's (fails closed).
  'devices.capability.request': (body) => typeof body['capabilityId'] === 'string' && /^device\.command\./.test(body['capabilityId']) ? N : O,
};

/**
 * The capabilities that are the owner's own acts (`owner-act` above): refused for anyone but the owner in person in every
 * mode (daemon/method-owner-decision.ts `makesOwnerOnlyAct`, applied by capabilities.run before the permission
 * manager), each with the place where the owner does it. A capability run through one of the methods above is one too by its
 * method's class; those with a handler of their own are listed here. Others are the owner's only for some values or with no
 * project (`ownerOnlyCapabilityCall`).
 */
export const OWNER_ONLY_CAPABILITIES: Readonly<Record<string, OwnerOnlyArea>> = {
  // Sign-ins and passwords.
  'local-auth.add': 'sign-ins', 'local-auth.remove': 'sign-ins', 'local-auth.password': 'sign-ins', 'local-auth.sign-out': 'sign-ins',
  'local-auth.remove-first-run-file': 'sign-ins', 'devices.sign-in-account': 'sign-ins', 'principals.create': 'sign-ins',
  'principals.update': 'sign-ins', 'principals.delete': 'sign-ins',
  // Credentials and pairings.
  'devices.migrate-shared': 'devices', 'devices.revoke-shared': 'devices', 'devices.relay-revoke': 'devices',
  // Who works where, and who reaches the owner's shared things.
  'devices.give-project': 'devices', 'devices.give-shared': 'devices', 'workspaces.register': 'projects', 'workspaces.unregister': 'projects',
  'chats.project': 'projects', 'chats.automatic-folder': 'projects',
  // Secrets: written, linked, trusted, removed or read out.
  'secrets.set': 'secrets', 'secrets.link': 'secrets', 'secrets.trust': 'secrets', 'secrets.delete': 'secrets',
  'provider.add': 'secrets', 'provider.remove': 'secrets', 'provider.import': 'secrets', 'provider.export': 'secrets',
  'provider.sign-out': 'secrets',
  'services.trust': 'secrets', 'services.import': 'secrets',
  'mail.password': 'secrets', 'mail.setup': 'secrets', 'calendar.connect': 'secrets', 'calendar.use-app': 'secrets', 'calendar.disconnect': 'secrets',
  'channels.connect': 'secrets', 'notify.add': 'secrets', 'notify.remove': 'secrets', 'notify.clear': 'secrets',
  'google.connect': 'secrets', 'google.reauthorize': 'secrets', 'google.adopt': 'secrets', 'google.setup': 'secrets',
  'google.client-file': 'secrets', 'google.client': 'secrets', 'google.calendar-address': 'secrets', 'google.forget': 'secrets',
  'google.account': 'secrets', 'telegram.configure': 'secrets', 'telegram.read': 'secrets', 'telegram.cancel': 'secrets',
  'telegram.revoke': 'secrets', 'telegram.release': 'secrets', 'payments.add-card': 'money', 'payments.remove-card': 'money',
  'payments.address': 'money', 'payments.security-code': 'money',
  // Spending limits raised and spending allowed ahead.
  'payments.approve': 'money', 'payments.repeat': 'money', 'work.budget': 'money',
  // The permission mode and rules, and the protections every turn runs under.
  'permissions.place': 'permissions', 'permissions.revoke': 'permissions', 'security.trust-folder': 'permissions',
  'security.enforce-policy': 'permissions', 'security.restore-policy': 'permissions',
  'security.host-mcp': 'permissions', 'security.host-commands': 'permissions', 'security.save-trust': 'permissions',
  // Managed locks.
  'managed.apply': 'settings', 'managed.apply-staged': 'settings', 'managed.unlock': 'settings', 'managed.lock': 'settings',
  'managed.rollback': 'settings', 'managed.stage': 'settings', 'settings-sync.pull': 'settings', 'settings-sync.resolve': 'settings',
  // What steers every project's turns: the owner's own memory restored, reviews, the owner's profile.
  'memory.restore': 'memory', 'notes.review': 'memory', 'personas.review': 'memory', 'routines.review': 'memory',
  'my-skills.review': 'memory', 'my-skills.bundle-review': 'memory', 'about-me.set': 'memory', 'about-me.note': 'memory',
  'about-me.undo': 'memory', 'about-me.forget': 'memory', 'about-me.forget-line': 'memory', 'knowledge.import-browser-history': 'memory',
  // Skills and plugins of no project run in every project's turns, as the owner.
  'my-skills.create': 'tools', 'my-skills.update': 'tools', 'my-skills.enable': 'tools', 'my-skills.disable': 'tools',
  'my-skills.delete': 'tools', 'my-skills.import-discovered': 'tools', 'my-skills.import-standard': 'tools',
  'my-skills.bundle-create': 'tools', 'my-skills.bundle-update': 'tools', 'my-skills.bundle-enable': 'tools',
  'my-skills.bundle-disable': 'tools', 'my-skills.bundle-delete': 'tools', 'skills.publish-local': 'tools', 'skills.unpublish': 'tools',
  'plugin.disable': 'tools', 'plugin.trust': 'tools',
  'plugin.publish-local': 'tools', 'plugin.unpublish': 'tools', 'marketplace.install': 'tools', 'marketplace.update': 'tools',
  'marketplace.rollback': 'tools', 'marketplace.uninstall': 'tools', 'marketplace.bundle-import': 'tools',
  'mcp.exempt': 'tools', 'mcp.unexempt': 'tools', 'mcp.trust': 'tools', 'mcp.role': 'tools',
  // The machine group.
  'cluster.sharing-on': 'group', 'cluster.create': 'group', 'cluster.join': 'group', 'cluster.key': 'group', 'cluster.rename': 'group',
  'cluster.rotate': 'group', 'cluster.forget': 'group', 'cluster.leave': 'group', 'cluster.publish': 'group', 'cluster.accept': 'group',
  'cloudflare.create-token': 'group', 'cloudflare.provision': 'group', 'cloudflare.disable': 'group', 'network-scan.on': 'group',
  'remote.dispatch': 'group', 'remote.dispatch-pool': 'group', 'remote.rerun-local': 'group',
  // Updates of the daemon itself, and a whole setup carried in over the owner's.
  'update.apply': 'daemon', 'update.rollback': 'daemon', 'startup.transfer-import': 'daemon',
  // Approving work as the owner's, and withdrawing the owner's questions. Handing a task over as work (`work.delegate`) is a
  // project act: a caller below the owner hands it over only in a project given to it, decided under the mode as an item of the
  // owner's list (its `ownerOnly`), and the work runs as that caller's, reads only, until the owner adopts it (work-plans.ts).
  'work.approve': 'work', 'questions.withdraw': 'work',
};

/** Where the owner makes an owner-only act in person, by area: named in the refusal's sentence. */
export type OwnerOnlyArea = 'sign-ins' | 'devices' | 'projects' | 'secrets' | 'money' | 'permissions' | 'settings' | 'memory'
  | 'tools' | 'group' | 'daemon' | 'work' | 'channels';

/** The words of where the owner does it, per area. */
export const OWNER_ONLY_WHERE: Readonly<Record<OwnerOnlyArea, string>> = {
  'sign-ins': 'Sign-ins in System, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  devices: 'Devices and network, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  projects: 'Devices and network or the project chooser, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  secrets: 'Secrets and the place of the account it belongs to, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  money: 'the Money place, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  permissions: 'Permissions and safety, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  settings: 'Settings, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  memory: 'Memory and About you, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  tools: 'Tools and skills, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  group: 'Devices and network (the machine group), signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  daemon: 'System, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  work: 'Work, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
  channels: 'Mail calendar and channels, signed in to the web UI as the owner or in the terminal app or the Agent on the owner\'s computer',
};

/** The area of an owner-only method, for its sentence (by its id's first part). */
export function ownerOnlyMethodArea(methodId: string): OwnerOnlyArea {
  const head = methodId.split('.')[0] ?? '';
  if (head === 'local_auth' || head === 'principals' || head === 'stepup') return 'sign-ins';
  if (head === 'pairing' || head === 'relay' || head === 'tailscale' || head === 'secureAddress' || head === 'workspaces' || head === 'devices') return 'devices';
  if (head === 'credentials' || head === 'providers' || head === 'cloudflare') return 'secrets';
  if (head === 'payments' || head === 'contracts') return 'money';
  if (head === 'permissions' || head === 'sessions') return 'permissions';
  if (head === 'config') return 'settings';
  if (head === 'memory' || head === 'profile' || head === 'occasions' || head === 'knowledge') return 'memory';
  if (head === 'mcp' || head === 'skills' || head === 'voice' || head === 'watchers') return 'tools';
  if (head === 'remote') return 'group';
  if (head === 'channels' || head === 'inbound') return 'channels';
  return 'daemon';
}

/** The ids of the settings capabilities: a write of one that loosens a protection is the owner's own act. */
const SETTINGS_WRITE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'settings.set', 'settings.reset', 'settings.copy-from-terminal-app', 'presets.load', 'presets.import', 'bundle.import',
]);
/** The capabilities that write the hooks, tool servers or rules of the project the call names, or the daemon's own with none. */
const PROJECT_OR_OWN_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'hooks.enable', 'hooks.disable', 'hooks.scaffold', 'hooks.chain', 'hooks.remove', 'hooks.import', 'mcp.remove',
]);

/**
 * Whether one call of a capability is the owner's own act (refused for anyone but the owner in person), and where the owner
 * makes it: a listed one always; a settings write whose values loosen a protection; a hook or tool server of no project
 * (none named, or the global MCP config); a project taken away from another caller (`devices.take-project`,
 * `devices.take-shared` naming anyone but the caller itself). Undefined: not the owner's own act for these values. Pure.
 */
export function ownerOnlyCapabilityCall(id: string, values: Readonly<Record<string, string>>, facts: {
  readonly loosens: boolean; readonly workingDirectory?: string | undefined; readonly principalId?: string | undefined;
}): OwnerOnlyArea | undefined {
  const listed = Object.hasOwn(OWNER_ONLY_CAPABILITIES, id) ? OWNER_ONLY_CAPABILITIES[id] : undefined;
  if (listed !== undefined) return listed;
  // The permission mode and rules, whichever way they change.
  const key = (values['key'] ?? '').trim();
  if ((id === 'settings.set' || id === 'settings.reset') && (key === 'permissions' || key.startsWith('permissions.'))) return 'permissions';
  if (SETTINGS_WRITE_CAPABILITY_IDS.has(id) && facts.loosens) return 'settings';
  if (PROJECT_OR_OWN_CAPABILITY_IDS.has(id)) {
    if (!facts.workingDirectory) return 'tools';
    if (id === 'mcp.remove' && (values['scope'] ?? 'project') !== 'project') return 'tools';
    return undefined;
  }
  if (id === 'devices.take-project' || id === 'devices.take-shared') {
    const who = (values['who'] ?? '').trim();
    return who !== '' && who === facts.principalId ? undefined : 'devices';
  }
  return undefined;
}

/**
 * The capabilities a model never runs, whoever's turn it is and in every mode (the effect table's `model.refused`,
 * added to their effects by capabilities/catalog.ts `capabilityEffects`): granting or withdrawing access, minting or
 * carrying out a credential, pairing a device, reading out a secret, the permission rules. A model's call of one is
 * refused at its turn's gate and at the daemon; nothing is asked.
 */
export const MODEL_NEVER_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  'devices.migrate-shared', 'devices.give-project', 'devices.give-shared', 'devices.revoke-shared', 'devices.approve', 'devices.reject',
  'provider.export', 'cluster.key', 'cluster.join', 'cluster.accept', 'secrets.trust', 'permissions.place', 'permissions.revoke',
  'security.enforce-policy', 'security.restore-policy', 'workspaces.register',
]);

/** The class of one call of a method: by its body where the table says the body decides, else the descriptor's. */
export function methodCallRisk(descriptor: { readonly id: string; readonly risk?: MethodRisk | undefined; readonly scopes?: readonly string[] | undefined }, body: unknown): MethodRisk {
  const byCall = Object.hasOwn(BY_CALL, descriptor.id) ? BY_CALL[descriptor.id] : undefined;
  if (byCall) {
    const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return byCall(record);
  }
  return riskOfDescriptor(descriptor);
}

/**
 * The class a method declares: its line in the table, else `none` for a read (every scope it needs is a read scope);
 * undefined for a method that changes something and is not in the table.
 */
export function declaredMethodRisk(id: string, effect: 'read' | 'write' | 'outward'): MethodRisk | undefined {
  const stated = Object.hasOwn(DECLARED, id) ? DECLARED[id] : undefined;
  if (stated !== undefined) return stated;
  return effect === 'read' ? 'none' : undefined;
}

/**
 * The class of a method as its descriptor carries it. A plugin's method that states none and changes anything (any
 * scope it needs is not a read scope, or it needs none) is the owner's own act, the most careful class; one that only
 * reads is `none`. A plugin that states no class still loads.
 */
export function riskOfDescriptor(descriptor: { readonly id: string; readonly risk?: MethodRisk | undefined; readonly scopes?: readonly string[] | undefined }): MethodRisk {
  if (descriptor.risk !== undefined) return descriptor.risk;
  const scopes = descriptor.scopes ?? [];
  return scopes.length > 0 && scopes.every((scope) => scope.startsWith('read:')) ? 'none' : 'owner-act';
}
