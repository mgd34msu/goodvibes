/**
 * `/security`, described once (command-actions/) for both terminal apps: the
 * one place for what protects this machine. Bare, it prints the short status
 * (`✓ Nothing needs attention.`, or each thing that does with the line that
 * fixes it). Its actions are the security review, paired-device tokens and
 * risky MCP routes; what is trusted, this folder's trust and the trust summary
 * file (what `/trust` did); the versioned policy bundles (what `/policy` did);
 * and the sandbox, its MCP containment and its sessions (what `/sandbox` did).
 *
 * The reads and writes each app has are its policy; an action an app does not
 * have is refused with where it is.
 */
import { existsSync } from 'node:fs';
import { buildMcpAttackPathReview } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { ApiTokenAuditor } from '@goodvibes-jev/engine/platform/platform/security';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import { dispatchPolicyCommand, type PolicyCommandContext } from '@goodvibes-jev/engine/platform/platform/gate/policy';
import {
  buildSandboxReview,
  inspectSandboxProbe,
  inspectSandboxSessionArtifact,
  listSandboxPresets,
  listSandboxProfiles,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
  renderSandboxSessions,
  type ConfigManagerLike,
  type SandboxSessionRegistry,
} from '@goodvibes-jev/engine/platform/platform/runtime/sandbox';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandReport, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, readAction, textInput } from './described-command-kit.js';

type AttackPathInput = Parameters<typeof buildMcpAttackPathReview>[0];

/** What each app reads and does for `/security`. */
export interface SecurityCommandPolicy<Ctx> {
  readonly tokens: (ctx: Ctx) => Pick<ApiTokenAuditor, 'auditAll'>;
  readonly security: (ctx: Ctx) => {
    readonly mcpServers: AttackPathInput['servers'];
    readonly recentMcpDecisions: AttackPathInput['recentDecisions'];
  };
  readonly policySnapshot: (ctx: Ctx) =>
    | { readonly lintFindings: readonly unknown[]; readonly lastPreflightReview?: { readonly status: string } | null | undefined }
    | undefined;
  readonly plugins: (ctx: Ctx) => readonly { readonly quarantined?: boolean | undefined; readonly trustTier: string }[];
  readonly subscriptions: (ctx: Ctx) => { list(): readonly unknown[]; listPending(): readonly unknown[] };
  /** The screens this app has. */
  readonly screens: {
    readonly security?: ((ctx: Ctx) => void) | undefined;
    readonly policy?: ((ctx: Ctx) => void) | undefined;
    readonly sandbox?: ((ctx: Ctx) => void) | undefined;
  };
  /** The trust summary: permission mode, secrets, services, plugins and MCP trust. */
  readonly trust: {
    review(ctx: Ctx): Promise<string>;
    save(ctx: Ctx, path: string): Promise<string>;
    read(ctx: Ctx, path: string): string;
  };
  /** This folder's trust decision, where this app makes one. */
  readonly folder?: {
    status(ctx: Ctx): Promise<string>;
    set(ctx: Ctx, level: 'trusted' | 'restricted'): Promise<string>;
    /** False while nothing was decided for this folder; undefined where there is no folder trust. */
    decided(ctx: Ctx): boolean | undefined;
  } | undefined;
  /** The policy-bundle workflow's context (prints through `ctx.print`). */
  readonly policyContext?: ((ctx: Ctx) => PolicyCommandContext) | undefined;
  /** The settings the sandbox actions read, and the one they write. */
  readonly sandboxConfig: (ctx: Ctx) => ConfigManagerLike & { setMcpIsolation(mode: 'contained' | 'disabled'): void };
  /** The sandbox session registry, where this app has one. */
  readonly sandboxSessions?: ((ctx: Ctx) => SandboxSessionRegistry | undefined) | undefined;
  readonly resolvePath: (ctx: Ctx, path: string) => string;
  /** Where the parts this app lacks are: "the terminal app (goodvibes)". */
  readonly elsewhere: string;
}

interface SandboxSessionsHolder {
  readonly workspace?: { readonly sandboxSessionRegistry?: Pick<SandboxSessionRegistry, 'list'> | null | undefined } | undefined;
}

const SANDBOX_SESSIONS = defineList<CommandActionContext>({
  name: 'security.sandbox-sessions',
  async read(ctx) {
    const registry = (ctx as CommandActionContext & SandboxSessionsHolder).workspace?.sandboxSessionRegistry;
    if (!registry) return [];
    return registry.list().map((session): ListRow => ({
      value: session.id, label: session.label || session.profileId, detail: `${session.profileId} · ${session.backend}`, state: session.state,
    }));
  },
  operator: { terminalOnly: 'Sandbox sessions belong to the terminal app that started them.' },
});

const PATH_INPUT = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path', kind: 'path', typed: { position: 1 } });
const REPLACE_INPUT: InputDescription = choiceInput({
  id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
  choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
  optional: { default: 'no', means: 'keep it and stop' },
});
const SESSION_INPUT: InputDescription = {
  id: 'session', label: 'Sandbox session', help: 'The sandbox sessions started here', kind: 'choice',
  choices: { list: SANDBOX_SESSIONS, allowOther: { reason: 'a session id' } }, required: true, typed: { position: 1 },
};
const TERMINAL_SESSIONS = { terminalOnly: 'Sandbox sessions belong to the terminal app that started them.' } as const;
const SCREEN = { terminalOnly: 'It opens a screen of the terminal app.' } as const;

function securityActions<Ctx extends CommandActionContext>(policy: SecurityCommandPolicy<Ctx>): ActionDescription<Ctx>[] {
  const notHere = (what: string): never => {
    throw commandRefusal(`${what} is not in this program; nothing was done.`, `It is in ${policy.elsewhere}.`);
  };
  const runPolicy = async (ctx: Ctx, args: readonly string[]): Promise<void> => {
    if (!policy.policyContext) return notHere('The policy bundles');
    await dispatchPolicyCommand(args, policy.policyContext(ctx));
  };
  const sessions = (ctx: Ctx): SandboxSessionRegistry => {
    const registry = policy.sandboxSessions?.(ctx);
    if (!registry) return notHere('Sandbox sessions');
    return registry;
  };
  const attackPaths = (ctx: Ctx) => {
    const snapshot = policy.security(ctx);
    return { snapshot, review: buildMcpAttackPathReview({ servers: snapshot.mcpServers, recentDecisions: snapshot.recentMcpDecisions }) };
  };
  return [
    readAction<Ctx>({
      id: 'report', label: 'See what needs attention', word: 'report',
      sentence: 'Checks paired-device tokens, the policies, MCP servers and their routes, plugins and this folder\'s trust, and names each thing that needs attention with the line that fixes it.',
      async run(_values, ctx): Promise<CommandReport> {
        const items: { sentence: string; fix?: { label: string; line: string } }[] = [];
        const audit = policy.tokens(ctx).auditAll(Date.now());
        if (audit.blocked.length > 0) items.push({ sentence: `${audit.blocked.length} paired-device token(s) are blocked from use.`, fix: { label: 'See the tokens', line: '/security tokens' } });
        if (audit.scopeViolations.length > 0) items.push({ sentence: `${audit.scopeViolations.length} paired-device token(s) reach beyond their policy.`, fix: { label: 'See the tokens', line: '/security tokens' } });
        if (audit.rotationOverdue.length > 0) items.push({ sentence: `${audit.rotationOverdue.length} paired-device token(s) are overdue for rotation.`, fix: { label: 'Pair the device again', line: '/devices' } });
        const policyState = policy.policySnapshot(ctx);
        if (policyState && policyState.lintFindings.length > 0) items.push({ sentence: `The policies have ${policyState.lintFindings.length} lint finding(s).`, fix: { label: 'See them', line: '/security lint-policy' } });
        if (policyState?.lastPreflightReview && policyState.lastPreflightReview.status !== 'pass') {
          items.push({ sentence: `The last policy preflight says ${policyState.lastPreflightReview.status}.`, fix: { label: 'Review it again', line: '/security preflight' } });
        }
        const { snapshot, review } = attackPaths(ctx);
        const quarantined = snapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
        if (quarantined > 0) items.push({ sentence: `${quarantined} MCP server(s) have tools held back for review.`, fix: { label: 'See which', line: '/mcp review' } });
        const elevated = snapshot.mcpServers.filter((server) => server.trustMode === 'allow-all').length;
        if (elevated > 0) items.push({ sentence: `${elevated} MCP server(s) may run any tool without asking.`, fix: { label: 'Choose what they may do', line: '/mcp' } });
        if (review.findings.length > 0) items.push({ sentence: `${review.findings.length} risky route(s) through MCP servers: ${review.summary}`, fix: { label: 'See them', line: '/security attack-paths' } });
        const plugins = policy.plugins(ctx);
        const heldPlugins = plugins.filter((plugin) => plugin.quarantined).length;
        if (heldPlugins > 0) items.push({ sentence: `${heldPlugins} plugin(s) are held back.`, fix: { label: 'See the plugins', line: '/plugin' } });
        if (policy.folder?.decided(ctx) === false) items.push({ sentence: 'Nothing was decided yet about trusting this folder.', fix: { label: 'See what trusting it means', line: '/security folder' } });
        if (items.length === 0) return { verdict: 'ok', headline: 'Nothing needs attention.', items: [] };
        return { verdict: 'attention', headline: `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention:`, items };
      },
    }),
    readAction<Ctx>({
      id: 'review', label: 'See the whole security review', word: 'review',
      sentence: 'Shows every count the review reads: tokens, subscriptions, policy findings, MCP servers and their routes, and plugins.',
      async run(_values, ctx) {
        const audit = policy.tokens(ctx).auditAll(Date.now());
        const { snapshot, review } = attackPaths(ctx);
        const policyState = policy.policySnapshot(ctx);
        const plugins = policy.plugins(ctx);
        const subscriptions = policy.subscriptions(ctx);
        return [
          'Security Review',
          `  tokens: ${audit.results.length}`,
          `  blocked tokens: ${audit.blocked.length}`,
          `  scope violations: ${audit.scopeViolations.length}`,
          `  rotation overdue: ${audit.rotationOverdue.length}`,
          `  rotation warnings: ${audit.rotationWarnings.length}`,
          `  built-in subscription providers: ${listBuiltinSubscriptionProviders().length}`,
          `  active subscriptions: ${subscriptions.list().length}`,
          `  pending subscriptions: ${subscriptions.listPending().length}`,
          `  policy lint findings: ${policyState ? policyState.lintFindings.length : 'no policy state here'}`,
          `  policy preflight: ${policyState?.lastPreflightReview?.status ?? 'not run'}`,
          `  mcp servers: ${snapshot.mcpServers.length}`,
          `  mcp quarantined: ${snapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length}`,
          `  mcp elevated: ${snapshot.mcpServers.filter((server) => server.trustMode === 'allow-all').length}`,
          `  mcp attack-path findings: ${review.findings.length}`,
          `  quarantined plugins: ${plugins.filter((plugin) => plugin.quarantined).length}`,
          `  untrusted plugins: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
        ].join('\n');
      },
    }),
    readAction<Ctx>({
      id: 'tokens', label: 'See paired-device tokens', word: 'tokens',
      sentence: 'Lists each paired device\'s token with its policy, whether it stays in scope, when it is due for rotation and whether it is blocked.',
      async run(_values, ctx) {
        const audit = policy.tokens(ctx).auditAll(Date.now());
        if (audit.results.length === 0) return 'No paired-device tokens: no device is paired with this machine (the list follows the hourly token audit).';
        return [
          `Paired-device tokens (${audit.results.length})`,
          ...audit.results.map((result) => `  ${result.label}  policy ${result.scope.policyId}  scope ${result.scope.outcome}  rotation ${result.rotation.outcome}  blocked ${result.blocked ? 'yes' : 'no'}`),
        ].join('\n');
      },
    }),
    readAction<Ctx>({
      id: 'attack-paths', label: 'See risky routes through MCP servers', word: 'attack-paths',
      sentence: 'Shows the routes by which an MCP server could reach files, the network or other tools further than its trust allows.',
      async run(_values, ctx) {
        const { review } = attackPaths(ctx);
        if (review.findings.length === 0) return 'No risky routes through MCP servers.';
        return [
          'Risky routes through MCP servers',
          `  summary: ${review.summary}`,
          ...review.findings.slice(0, 12).map((finding) => `  ${finding.severity.toUpperCase()} ${finding.serverName}  ${finding.route}\n    ${finding.reason}`),
        ].join('\n');
      },
    }),
    readAction<Ctx>({
      id: 'trust', label: 'See what is trusted', word: 'trust',
      sentence: 'Shows the permission mode, how many secrets and services are set up, and how far each plugin and MCP server is trusted.',
      async run(_values, ctx) { return policy.trust.review(ctx); },
    }),
    readAction<Ctx>({
      id: 'folder', label: 'See whether this folder is trusted', word: 'folder',
      sentence: 'Shows whether this folder is trusted, restricted or not decided, and what each means here.',
      async run(_values, ctx) {
        if (!policy.folder) return notHere('Folder trust');
        return policy.folder.status(ctx);
      },
    }),
    {
      id: 'trust-folder', label: 'Trust this folder', word: 'trust-folder', inputs: [],
      sentence: 'This folder becomes trusted: its own hooks and MCP servers may run and tools may change it, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'restrict-folder',
      ownerOnly: { reason: 'it lets this folder\'s own files decide what runs', instead: 'Ask the owner to trust it: /security trust-folder.' },
      operator: { terminalOnly: 'Folder trust is decided in the app that opened the folder.' }, example: {},
      async run(_values, ctx) {
        if (!policy.folder) return notHere('Folder trust');
        return policy.folder.set(ctx, 'trusted');
      },
    },
    {
      id: 'restrict-folder', label: 'Restrict this folder', word: 'restrict-folder', inputs: [],
      sentence: 'This folder becomes restricted: its own hooks and MCP servers stay off, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'trust-folder',
      operator: { terminalOnly: 'Folder trust is decided in the app that opened the folder.' }, example: {},
      async run(_values, ctx) {
        if (!policy.folder) return notHere('Folder trust');
        return policy.folder.set(ctx, 'restricted');
      },
    },
    {
      id: 'save-trust', label: 'Save the trust summary to a file', word: 'save-trust',
      inputs: [PATH_INPUT('Where to write it; only you can read it'), REPLACE_INPUT],
      sentence: 'The trust summary (secret names, not values) will be written to {path}, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The file is written on the terminal app\'s machine.' }, example: { path: 'trust-review.json' },
      async run(values, ctx) {
        const target = policy.resolvePath(ctx, values.path!);
        if (existsSync(target) && values.replace !== 'yes') throw commandRefusal(`${target} already exists; nothing was written.`, `Write over it: /security save-trust ${values.path} --replace`);
        return policy.trust.save(ctx, values.path!);
      },
    },
    readAction<Ctx>({
      id: 'read-trust', label: 'Read a saved trust summary', word: 'read-trust',
      inputs: [PATH_INPUT('A trust summary saved earlier')],
      sentence: 'Reads the trust summary saved in {path} and shows what it recorded.',
      example: { path: 'trust-review.json' },
      async run(values, ctx) { return policy.trust.read(ctx, values.path!); },
    }),
    readAction<Ctx>({
      id: 'policy', label: 'See the policy in force', word: 'policy',
      sentence: 'Shows the policy bundle in force, the candidate waiting, the history and what the candidate would change.',
      async run(_values, ctx) { await runPolicy(ctx, ['status']); },
    }),
    {
      id: 'load-policy', label: 'Load a candidate policy', word: 'load-policy',
      inputs: [PATH_INPUT('The policy bundle file')],
      sentence: 'The bundle in {path} becomes the candidate policy until you change it; nothing is enforced until you enforce it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The bundle file is read on the terminal app\'s machine.' }, example: { path: 'policy-bundle.json' },
      async run(values, ctx) { await runPolicy(ctx, ['load', values.path!]); },
    },
    readAction<Ctx>({
      id: 'simulate-policy', label: 'See what the candidate policy changes', word: 'simulate-policy',
      sentence: 'Decides this machine\'s recorded calls again under the candidate and shows each one it decides differently; no model is asked.',
      async run(_values, ctx) { await runPolicy(ctx, ['simulate']); },
    }),
    readAction<Ctx>({
      id: 'compare-policy', label: 'Compare the candidate with the policy in force', word: 'compare-policy',
      sentence: 'Shows the rules the candidate adds, removes, changes and moves.',
      async run(_values, ctx) { await runPolicy(ctx, ['diff']); },
    }),
    readAction<Ctx>({
      id: 'lint-policy', label: 'Check the policies for mistakes', word: 'lint-policy',
      sentence: 'Lints the policy in force and the candidate and lists each finding.',
      async run(_values, ctx) { await runPolicy(ctx, ['lint']); },
    }),
    readAction<Ctx>({
      id: 'preflight', label: 'Review policy and MCP risk', word: 'preflight',
      sentence: 'Reviews the policy, the settings and the MCP servers\' trust together and lists each issue.',
      async run(_values, ctx) { await runPolicy(ctx, ['preflight']); },
    }),
    {
      id: 'enforce-policy', label: 'Enforce the candidate policy', word: 'enforce-policy', inputs: [],
      sentence: 'The candidate becomes the policy in force, deciding the calls "See what the candidate policy changes" showed differently, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'restore-policy',
      ownerOnly: { reason: 'a new policy may allow what the one in force refuses', instead: 'Ask the owner to enforce it: /security enforce-policy.' },
      operator: { terminalOnly: 'The policy registry is the terminal app\'s.' }, example: {},
      async run(_values, ctx) { await runPolicy(ctx, ['promote', '--yes']); },
    },
    {
      id: 'restore-policy', label: 'Go back to the previous policy', word: 'restore-policy', inputs: [],
      sentence: 'The policy in force before the last one is enforced again, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'enforce-policy',
      ownerOnly: { reason: 'the previous policy may allow what the one in force refuses', instead: 'Ask the owner: /security restore-policy.' },
      operator: { terminalOnly: 'The policy registry is the terminal app\'s.' }, example: {},
      async run(_values, ctx) { await runPolicy(ctx, ['rollback']); },
    },
    readAction<Ctx>({
      id: 'sandbox', label: 'See the sandbox', word: 'sandbox',
      sentence: 'Shows whether commands and MCP servers run inside a process boundary on this machine, and which backend does it.',
      async run(_values, ctx) { return renderSandboxReview(policy.sandboxConfig(ctx)); },
    }),
    readAction<Ctx>({
      id: 'sandbox-advice', label: 'See what the sandbox should be', word: 'sandbox-advice',
      sentence: 'Says what to set for the sandbox on this machine, and why.',
      async run(_values, ctx) { return renderSandboxRecommendation(policy.sandboxConfig(ctx)); },
    }),
    readAction<Ctx>({
      id: 'sandbox-profiles', label: 'See the sandbox profiles', word: 'sandbox-profiles',
      sentence: 'Lists the sandbox profiles (commands, MCP servers) with what each may reach and the backend that runs it.',
      async run(_values, ctx) { return renderSandboxProfiles(policy.sandboxConfig(ctx)); },
    }),
    readAction<Ctx>({
      id: 'sandbox-presets', label: 'See the sandbox presets', word: 'sandbox-presets',
      sentence: 'Lists the presets for MCP servers, what each sets and its notes.',
      async run() {
        return ['Sandbox presets', ...listSandboxPresets().flatMap((preset) => [
          `  ${preset.label} (${preset.id}): ${preset.summary}`,
          `    MCP servers: ${preset.config.mcpIsolation === 'contained' ? 'inside the sandbox (/security contain-mcp)' : 'as host processes (/security host-mcp)'}`,
          ...preset.notes.map((note) => `    ${note}`),
        ])].join('\n');
      },
    }),
    readAction<Ctx>({
      id: 'sandbox-probe', label: 'Probe the sandbox on this machine', word: 'sandbox-probe',
      sentence: 'Probes which process boundary this machine can run now, with any warnings.',
      async run(_values, ctx) {
        const review = buildSandboxReview(policy.sandboxConfig(ctx));
        return [
          inspectSandboxProbe({
            version: 1, checkedAt: Date.now(), host: review.host.platform,
            currentBackend: review.backendProbe?.resolvedBackend ?? 'host', mcpIsolation: review.config.mcpIsolation,
            secureSandboxReady: review.host.secureSandboxReady, recommendedCommand: '/health check sandbox',
          }),
          ...review.host.warnings.map((warning) => `  warning: ${warning}`),
        ].join('\n');
      },
    }),
    {
      id: 'contain-mcp', label: 'Run MCP servers inside the sandbox', word: 'contain-mcp', inputs: [],
      sentence: 'Each MCP server starts inside its own process boundary when it next connects, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'host-mcp',
      operator: { terminalOnly: 'The web UI sets sandbox.mcpIsolation on its settings screen.' }, example: {},
      async run(_values, ctx) {
        const config = policy.sandboxConfig(ctx);
        config.setMcpIsolation('contained');
        return buildSandboxReview(config).host.secureSandboxReady
          ? 'MCP servers start inside their own bubblewrap boundary when they next connect (/mcp reload).'
          : 'Saved, but this machine has no bubblewrap: a stdio MCP server will not start until bubblewrap is installed or MCP servers run as host processes again.';
      },
    },
    {
      id: 'host-mcp', label: 'Run MCP servers as host processes', word: 'host-mcp', inputs: [],
      sentence: 'MCP servers start as ordinary processes of this machine, with no boundary, when they next connect, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'contain-mcp',
      ownerOnly: { reason: 'it takes the process boundary away from MCP servers', instead: 'Ask the owner: /security host-mcp.' },
      operator: { terminalOnly: 'The web UI sets sandbox.mcpIsolation on its settings screen.' }, example: {},
      async run(_values, ctx) {
        policy.sandboxConfig(ctx).setMcpIsolation('disabled');
        return 'MCP servers run as host processes when they next connect (/mcp reload).';
      },
    },
    readAction<Ctx>({
      id: 'sandbox-sessions', label: 'See the sandbox sessions', word: 'sandbox-sessions',
      sentence: 'Lists the sandbox sessions started here, with their profile, backend and state.',
      async run(_values, ctx) { return renderSandboxSessions(sessions(ctx).list()); },
    }),
    {
      id: 'start-sandbox', label: 'Start a sandbox session', word: 'start-sandbox',
      inputs: [
        choiceInput({
          id: 'profile', label: 'Profile', help: 'What the session is for', typed: { position: 1 },
          choices: listSandboxProfiles().map((profile) => ({ value: profile.id, label: profile.label })),
        }),
        choiceInput({
          id: 'where', label: 'Boundary', help: 'Inside the sandbox, or on this machine with no boundary', typed: { flag: '--host', switchOn: 'host' },
          choices: [
            { value: 'contained', label: 'Inside the sandbox' },
            { value: 'host', label: 'On this machine, with no boundary', help: 'It reaches the host\'s files and network.', risk: 'loosens-a-protection' },
          ],
          optional: { default: 'contained', means: 'inside the sandbox' },
        }),
        textInput({ id: 'label', label: 'Name', help: 'A name to tell it apart', why: 'a name you choose', typed: { tail: true }, optional: { default: '', means: 'the profile\'s name' } }),
      ],
      sentence: 'A {profile} sandbox session starts and stays until you stop it, for this session only.',
      done: '', touches: 'this-machine', lasts: 'session', risk: 'none', undoneBy: 'stop-sandbox',
      operator: TERMINAL_SESSIONS, example: { profile: 'command', label: 'build check' },
      async run(values, ctx) {
        const session = await sessions(ctx).start(values.profile as Parameters<SandboxSessionRegistry['start']>[0], values.label || undefined, policy.sandboxConfig(ctx), { host: values.where === 'host' });
        return [
          `Started sandbox session ${session.id} for ${session.profileId} (backend ${session.backend}, ${session.state}, start-up ${session.startupStatus ?? 'not reported'}).`,
          ...(session.startupDetail ? [`  ${session.startupDetail}`] : []),
        ].join('\n');
      },
    },
    readAction<Ctx>({
      id: 'sandbox-session', label: 'See a sandbox session', word: 'sandbox-session',
      inputs: [SESSION_INPUT],
      sentence: 'Shows sandbox session {session}: its profile, backend, state and the last command it ran.',
      example: { session: 'sbx-1a2b' },
      operator: TERMINAL_SESSIONS,
      async run(values, ctx) {
        const session = sessions(ctx).get(values.session!);
        if (!session) throw commandRefusal(`No sandbox session is ${values.session}.`, '/security sandbox-sessions lists them.');
        return [
          `Sandbox session ${session.id}`,
          `  profile: ${session.profileId}`,
          `  kind: ${session.kind}`,
          `  state: ${session.state}`,
          `  backend: ${session.backend}`,
          `  start-up: ${session.startupStatus ?? 'not reported'}`,
          ...(session.startupDetail ? [`  detail: ${session.startupDetail}`] : []),
          ...(session.lastCommandSummary ? [`  last: ${session.lastCommandSummary}`] : []),
        ].join('\n');
      },
    }),
    {
      id: 'stop-sandbox', label: 'Stop a sandbox session', word: 'stop-sandbox',
      inputs: [SESSION_INPUT],
      sentence: 'Sandbox session {session} stops; what runs in it ends.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: TERMINAL_SESSIONS, example: { session: 'sbx-1a2b' },
      async run(values, ctx) {
        const session = sessions(ctx).stop(values.session!);
        if (!session) throw commandRefusal(`No sandbox session is ${values.session}; nothing was stopped.`, '/security sandbox-sessions lists them.');
        return `Stopped sandbox session ${session.id}.`;
      },
    },
    doAction<Ctx>({
      id: 'run-in-sandbox', label: 'Run a command in a sandbox session', word: 'run-in-sandbox',
      inputs: [
        SESSION_INPUT,
        textInput({ id: 'command', label: 'Command', help: 'The program and its arguments', why: 'a command line', typed: { tail: true } }),
      ],
      sentence: 'Runs {command} inside sandbox session {session} (at most 10 seconds) and shows what it printed.',
      operator: TERMINAL_SESSIONS, example: { session: 'sbx-1a2b', command: 'git status' },
      async run(values, ctx) {
        const [program, ...args] = values.command!.trim().split(/\s+/);
        if (!program) throw commandRefusal('Name the program to run; nothing was run.');
        try {
          const result = await sessions(ctx).execute(values.session!, program, args, { timeoutMs: 10000 });
          const stdout = result.stdout.trim();
          const stderr = result.stderr.trim();
          return [`Ran in sandbox session ${values.session}`, `  status: ${result.status ?? 'none'}`, ...(stdout ? [`  stdout: ${stdout}`] : []), ...(stderr ? [`  stderr: ${stderr}`] : [])].join('\n');
        } catch (error) {
          throw commandRefusal(`Not run in sandbox session ${values.session}: ${summarizeError(error)}`);
        }
      },
    }),
    {
      id: 'save-sandbox', label: 'Save a sandbox session\'s record to a file', word: 'save-sandbox',
      inputs: [SESSION_INPUT, { ...PATH_INPUT('Where to write it'), typed: { position: 2 } }],
      sentence: 'The record of sandbox session {session} will be written to {path}, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: TERMINAL_SESSIONS, example: { session: 'sbx-1a2b', path: 'sandbox-session.json' },
      async run(values, ctx) {
        const target = policy.resolvePath(ctx, values.path!);
        sessions(ctx).exportArtifact(values.session!, target, policy.sandboxConfig(ctx));
        return `Saved the record of sandbox session ${values.session} to ${target}.`;
      },
    },
    readAction<Ctx>({
      id: 'read-sandbox', label: 'Read a saved sandbox session record', word: 'read-sandbox',
      inputs: [PATH_INPUT('A sandbox session record saved earlier')],
      sentence: 'Reads the sandbox session record saved in {path} and shows what it recorded.',
      example: { path: 'sandbox-session.json' },
      operator: TERMINAL_SESSIONS,
      async run(values, ctx) { return inspectSandboxSessionArtifact(sessions(ctx).inspectArtifact(policy.resolvePath(ctx, values.path!))); },
    }),
    doAction<Ctx>({
      id: 'security-screen', label: 'Open the security screen', word: 'security-screen', touches: 'reads',
      sentence: 'Opens the security screen: tokens, governance, MCP routes and the latest failure.', operator: SCREEN,
      async run(_values, ctx) {
        const open = policy.screens.security;
        if (!open) return notHere('The security screen');
        open(ctx);
      },
    }),
    doAction<Ctx>({
      id: 'policy-screen', label: 'Open the policy screen', word: 'policy-screen', touches: 'reads',
      sentence: 'Opens the policy screen: the bundles, their diff, the calls decided differently and the preflight.', operator: SCREEN,
      async run(_values, ctx) {
        const open = policy.screens.policy;
        if (!open) return notHere('The policy screen');
        open(ctx);
      },
    }),
    doAction<Ctx>({
      id: 'sandbox-screen', label: 'Open the sandbox screen', word: 'sandbox-screen', touches: 'reads',
      sentence: 'Opens the sandbox screen: the boundary, the MCP containment and the sandbox sessions.', operator: SCREEN,
      async run(_values, ctx) {
        const open = policy.screens.sandbox;
        if (!open) return notHere('The sandbox screen');
        open(ctx);
      },
    }),
  ];
}

/** `/security` for one app. */
export function createSecurityCommand<Ctx extends CommandActionContext>(policy: SecurityCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'security',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Security',
    summary: 'See what protects this machine: tokens, trust, policies and the sandbox, and change them',
    group: 'Security',
    report: 'report',
    firstScreenRows: [
      'report',
      'review',
      { label: 'Tokens and MCP routes…', actions: ['tokens', 'attack-paths'] },
      { label: 'What is trusted…', actions: ['trust', 'folder', 'trust-folder', 'restrict-folder', 'save-trust', 'read-trust'] },
      { label: 'Policies…', actions: ['policy', 'load-policy', 'simulate-policy', 'compare-policy', 'lint-policy', 'preflight', 'enforce-policy', 'restore-policy'] },
      { label: 'Sandbox…', actions: ['sandbox', 'sandbox-advice', 'sandbox-profiles', 'sandbox-presets', 'sandbox-probe', 'contain-mcp', 'host-mcp'] },
      { label: 'Sandbox sessions…', actions: ['sandbox-sessions', 'start-sandbox', 'sandbox-session', 'stop-sandbox', 'run-in-sandbox', 'save-sandbox', 'read-sandbox'] },
      { label: 'Screens…', actions: ['security-screen', 'policy-screen', 'sandbox-screen'] },
    ],
    actions: securityActions(policy),
  });
}
