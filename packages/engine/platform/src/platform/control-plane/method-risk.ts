/**
 * method-risk.ts, the risk class of every builtin daemon method: what calling it does that the owner decides, in the
 * capability layer's own words (capabilities/command-line-hold.ts). The daemon's dispatch reads it once for every call
 * (daemon/method-owner-decision.ts): a method of a class other than `none`, called by anyone but the owner's own
 * program with a person's press, is decided as the capability that does the same act would be (put to the owner,
 * opening on No, or decided under his mode); a no-risk method is admitted by its effects alone, as before.
 *
 *   - `loosens-a-protection`: weakens a protection, or installs something that runs by itself (a schedule, a watcher, a
 *     tool server, a system service);
 *   - `steers-a-model`: writes what steers a model in the owner's turns (a memory record, a profile fact, a skill), the
 *     capability layer's `steersModel` (capabilities/types.ts): the owner's own program writes it as his (his press, or
 *     his model in his own conversation, kept with its author); anyone else's write is decided as the capability's;
 *   - `cannot-be-undone`: deletes or ends what nothing restores;
 *   - `spends-money`: a purchase, a batch of metered model work, a budget raised;
 *   - `writes-a-secret`: stores a credential, a key or a card;
 *   - `owner-act`: an act only the owner makes himself (granting or withdrawing access, minting a credential);
 *   - `answers-the-owner`: answers something addressed to the owner (an approval, an inbox question, a plan, a device
 *     or a machine waiting to pair, a held channel message, a purchase window, a rewind request, a tidying proposal):
 *     answered by him or refused, never itself put to him (method-owner-decision.ts `ownerAnswers`). The one list of
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
export type MethodRisk = 'none' | 'loosens-a-protection' | 'steers-a-model' | 'cannot-be-undone' | 'spends-money' | 'writes-a-secret' | 'owner-act' | 'answers-the-owner';

export const METHOD_RISKS: readonly MethodRisk[] = ['none', 'loosens-a-protection', 'steers-a-model', 'cannot-be-undone', 'spends-money', 'writes-a-secret', 'owner-act', 'answers-the-owner'];

const L = 'loosens-a-protection' as const;
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
  // Devices (device.capture, device.delete-capture, device.revoke-grant).
  'devices.capability.request': N, 'devices.artifacts.list': N, 'devices.artifacts.read': N, 'devices.artifacts.delete': U,
  'devices.grants.revoke': N, 'devices.housekeeping.run': N,
  // Memory: restoring a snapshot replaces what the owner keeps (memory.restore, his own act).
  'memory.consolidation.decide': A, 'memory.snapshots.restore': O,
  // Voice: installing a local model is software that runs here.
  'voice.local.install': L, 'voice.setup': N, 'voice.wake.provision': N,
  // Web chat.
  'companion.chat.sessions.create': N, 'companion.chat.sessions.update': N, 'companion.chat.sessions.close': N,
  'companion.chat.sessions.reopen': N, 'companion.chat.sessions.delete': U, 'companion.chat.messages.create': N,
  'companion.chat.messages.retry': N, 'companion.chat.messages.edit': N, 'companion.chat.branches.switch': N,
  'companion.chat.messages.steer': N, 'companion.chat.turns.cancel': N, 'companion.chat.queuedMessages.edit': N,
  'companion.chat.queuedMessages.delete': N, 'companion.chat.attachments.remove': U,
  // Automation: a job or a schedule runs by itself (schedule.add, schedule.change, schedule.resume loosen).
  'automation.jobs.create': L, 'automation.jobs.update': L, 'automation.jobs.delete': U, 'automation.jobs.enable': L,
  'automation.jobs.disable': N, 'automation.jobs.run': N, 'automation.runs.cancel': U, 'automation.runs.retry': N,
  'automation.heartbeat.run': N, 'automation.schedules.create': L, 'automation.schedules.delete': U, 'automation.schedules.resume': L,
  'automation.schedules.pause': N, 'automation.schedules.run': N,
  // Route bindings send a channel's messages into a conversation.
  'routes.bindings.create': L, 'routes.bindings.update': L, 'routes.bindings.delete': U,
  // Fleet, checkpoints, contracts. A raised budget lets a contract spend more.
  'fleet.archive': N, 'fleet.unarchive': N, 'fleet.archiveFinished': N, 'fleet.attempts.pick': N, 'fleet.attempts.judge': N,
  'fleet.observed.steer': N, 'fleet.conflicts.resolve': N, 'fleet.conflicts.retry': N,
  'checkpoints.create': N, 'checkpoints.restore': N, 'checkpoints.revertHunk': N,
  'fleet.stop': N, 'fleet.interrupt': N, 'fleet.resume': N,
  'contracts.start': N, 'contracts.dispatch': N, 'contracts.cancel': N, 'contracts.reply': A, 'contracts.remove': U,
  'contracts.retryUnit': N, 'contracts.budget': M,
  'judgment.battery.run': N,
  // Channels: signing an account in, authorizing a surface, its allowlist and its rules decide who reaches the owner
  // (channels.set-rules, channels.own-messages loosen).
  'channels.accounts.action.default': L, 'channels.accounts.action.named': L, 'channels.tools.invoke': N, 'channels.actions.invoke': N,
  'channels.targets.resolve': N, 'channels.authorize': L, 'channels.allowlist.resolve': N, 'channels.allowlist.edit': L,
  'channels.policies.update': L,
  // Watchers run by themselves.
  'watchers.create': L, 'watchers.update': L, 'watchers.delete': U, 'watchers.start': L, 'watchers.stop': N, 'watchers.run': N,
  // The system service starts by itself at boot.
  'services.install': L, 'services.start': N, 'services.stop': N, 'services.restart': N, 'services.uninstall': N,
  'channels.inbox.applyLabels': N, 'channels.inbox.triage': N, 'channels.routing.assign': N, 'channels.routing.delete': U,
  'channels.drafts.save': N, 'channels.drafts.delete': U,
  'homeassistant.conversation.submit': N, 'homeassistant.conversation.stream': N, 'homeassistant.conversation.cancel': N,
  // Triggers (triggers.watch, triggers.restart, triggers.allow-command loosen; triggers.stop cannot be undone).
  'watchers.triggers.create': L, 'watchers.triggers.cancel': U, 'watchers.triggers.reset': L, 'watchers.triggers.grant.register': L,
  'channels.test.send': N,
  // Removing a permission rule can take away a refusal.
  'permissions.rules.delete': L,
  'inbox.answer': A, 'inbox.post': N, 'inbox.withdraw': N, 'inbox.delivery': N,
  'notifications.send': N, 'notifications.deadLetters.replay': N,
  'email.draft.create': N, 'email.draft.update': N, 'email.send': N, 'email.inbox.update': N, 'email.expectation.open': N,
  'email.expectation.cancel': N,
  // Payments.
  // Approving or denying a purchase window answers what was put to the owner (it spends only on his own answer).
  'payments.purchase.reconcile': O, 'payments.purchase.securityCode': O, 'payments.purchase.approve': A, 'payments.purchase.deny': A,
  'payments.purchase.cancel': N, 'payments.cards.create': S, 'payments.cards.delete': U, 'payments.checkout.approve': A,
  'payments.standing.create': M, 'payments.standing.delete': N, 'payments.checkout.begin': M,
  // Calendar (calendar.delete cannot be undone).
  'calendar.events.create': N, 'calendar.events.update': N, 'calendar.events.delete': U, 'calendar.ics.import': N,
  'browser.provision': N, 'browser.sessions.launch': N, 'browser.sessions.attach': N, 'browser.sessions.release': N,
  'browser.sessions.close': N, 'browser.navigate': N, 'browser.click': N, 'browser.type': N, 'browser.select': N, 'browser.press': N,
  'browser.scroll': N, 'browser.tabs.create': N, 'browser.tabs.switch': N, 'browser.tabs.close': N, 'browser.history.back': N,
  'browser.history.forward': N,
  // Tool servers: one added runs by itself, and its trust, its role and an unblocked or exempted tool loosen.
  'mcp.servers.upsert': L, 'mcp.servers.remove': U, 'mcp.servers.tools.block': N, 'mcp.servers.tools.unblock': L,
  'mcp.servers.tools.exempt': L, 'mcp.servers.tools.unexempt': N, 'mcp.servers.trust.set': L, 'mcp.servers.role.set': L,
  'mcp.servers.reload': N, 'mcp.servers.quarantine.accept': L,
  // Remote peers (devices.approve and devices.reject are the owner's own acts).
  'remote.pair.requests.approve': A, 'remote.pair.requests.reject': A, 'remote.peers.token.rotate': O, 'remote.peers.token.revoke': O,
  'remote.peers.disconnect': N, 'remote.peers.invoke': N, 'remote.backends.register': L, 'remote.backends.remove': U,
  'remote.work.cancel': N,
  'worktrees.setup.run': N, 'worktrees.discard': U,
  // Memory records steer the owner's turns (the capability layer's `steersModel`).
  'memory.vector.rebuild': N, 'memory.embeddings.default.set': N, 'memory.records.add': T, 'memory.records.update-review': T,
  'memory.records.delete': U, 'memory.records.import': T, 'memory.records.update': T, 'memory.records.links.add': T,
  // Models and providers (provider.finish is the owner's own act; an API key is a secret).
  'models.current.set': N, 'models.refresh': N, 'providers.subscription.signIn.begin': N, 'providers.subscription.signIn.finish': O,
  'providers.apiKey.set': S,
  // Batches spend provider money.
  'batch.jobs.create': M, 'batch.jobs.cancel': N, 'batch.providerBatches.cancel': N, 'batch.run': M,
  // Cloudflare (cloudflare.create-token and cloudflare.provision are the owner's own acts).
  'cloudflare.token.create': O, 'cloudflare.provision': O, 'cloudflare.disable': N,
  'update.check': N,
  // The relay (devices.relay-revoke cannot be undone).
  'relay.pairing.mint': O, 'relay.codes.revoke': U,
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
  'credentials.set': S, 'credentials.delete': U,
  // Settings: a change that loosens is held by the settings route itself, by the value (SELF_HELD below).
  'config.set': L, 'config.setMany': L, 'config.reset': L,
  'push.subscriptions.create': N, 'push.subscriptions.reconcile': N, 'push.subscriptions.delete': N, 'push.subscriptions.verify': N,
  // Pairing: a credential minted for someone (a migration included: it mints a credential of full authority), a
  // hand-off made, the operator token withdrawn. The daemon's own migration at an upgrade is its own act (the system).
  'pairing.tokens.create': O, 'pairing.tokens.rename': N, 'pairing.tokens.delete': U, 'pairing.tokens.migrate': O,
  'pairing.tokens.revokeShared': U, 'pairing.handoff.create': O, 'pairing.serve.network': L, 'pairing.handoff.complete': O,
  // The outside agent's own credential: an automation pairing with no project and no person's claim, issued once per
  // daemon. Making it is making a credential, the owner's own act (asked of him once, at the first `mcp serve`).
  'pairing.outsideAgent.issue': O,
  // Serving the daemon beyond this machine.
  'tailscale.serve.run': L, 'tailscale.serve.stop': N,
  // A new certificate authority is a new credential every phone is told to trust (and the old one's trust ends): his
  // own act. A new server certificate under the same authority widens nothing.
  'secureAddress.set': S, 'secureAddress.reissue': N, 'secureAddress.replaceAuthority': O, 'secureAddress.serve': L,
  // The capability methods decide each call themselves (routes/capabilities.ts); the program's posts change nothing of his.
  'capabilities.run': N, 'hooks.trace.post': N, 'context.windows.learned.post': N, 'permissions.audit.post': N,
  // Another coding agent, long-running, that runs its own tools under its own rules (agents.host, its capability).
  'acp.sessions.create': L,
  // Skills and the owner's profile steer a model.
  'skills.create': T, 'skills.update': T, 'skills.delete': U,
  'principals.create': O, 'principals.update': O, 'principals.delete': O,
  // A fact about the owner keeps no author to wait under (as a memory record does): anyone else's write is put to him in
  // every mode, as the About you capabilities are (their `ownerOnly`); the Agent's profile tool keeps its native admission.
  'profile.set': O, 'profile.append': O, 'profile.forget': O, 'profile.undo': O,
  // The owner's own reply to a nudge (yes, no, later, in hand) and to a gift question: his own act. His model in his own
  // turn records it under his mode, by its native admission (as the profile's); anyone else's is put to him.
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
  // expired: minting one is his own act (another caller's mints would fill the table, STEP_UP_CHALLENGES_FULL, and
  // leave him no step-up), never a read.
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
 * credential is made only for the owner himself, daemon/method-owner-decision.ts `mintsAgentCredential`):
 *   - `checkin.config.set`: switched on, it puts the check-in job on the scheduler (it runs by itself), and a delivery
 *     channel named sends the owner's briefings there: both loosen; quiet hours or cadence alone do not;
 *   - `ci.watches.create`: with a fix session on a failure, a failure later starts a session that spends model time (as
 *     the ci.watch capability's "Also start a fix session" choice says); a watch that only tells spends nothing.
 */
const BY_CALL: Readonly<Record<string, (body: Readonly<Record<string, unknown>>) => MethodRisk>> = {
  'checkin.config.set': (body) => body['enabled'] === true || (typeof body['deliveryChannel'] === 'string' && body['deliveryChannel'].trim() !== '') ? L : N,
  'ci.watches.create': (body) => body['triggerFixSession'] === true ? M : N,
};

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
