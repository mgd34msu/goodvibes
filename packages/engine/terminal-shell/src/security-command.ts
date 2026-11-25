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
import { buildMcpAttackPathReview } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { ApiTokenAuditor } from '@goodvibes/engine/platform/platform/security';
import { listBuiltinSubscriptionProviders } from '@goodvibes/engine/platform/platform/config';
import { dispatchPolicyCommand, type PolicyCommandContext } from '@goodvibes/engine/platform/platform/gate/policy';
import {
  buildSandboxReview,
  inspectSandboxProbe,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
  type ConfigManagerLike,
  type SandboxSessionRegistry,
} from '@goodvibes/engine/platform/platform/runtime/sandbox';
import {
  SECURITY_FOLDER, SECURITY_READ_SANDBOX, SECURITY_RESTRICT_FOLDER, SECURITY_RUN_IN_SANDBOX, SECURITY_SANDBOX_PRESETS, SECURITY_SANDBOX_SESSION,
  SECURITY_SANDBOX_SESSIONS, SECURITY_SAVE_SANDBOX, SECURITY_START_SANDBOX, SECURITY_STOP_SANDBOX, SECURITY_TOKENS, SECURITY_TRUST_FOLDER,
  type SandboxSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { McpIsolationChange } from '@goodvibes/engine/platform/platform/mcp';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { ActionDescription, CommandActionContext, CommandReport, InputDescription } from './command-actions/types.js';
import { REPLACE_FILE_INPUT, doAction, readAction, textInput } from './described-command-kit.js';

type AttackPathInput = Parameters<typeof buildMcpAttackPathReview>[0];

/** The answer to a change of MCP containment: what runs how from now on, which servers restarted, which restart after their call. */
function describeIsolationChange(change: McpIsolationChange | null, headline: string): string {
  if (change === null) return headline;
  const lines = [headline];
  if (change.restarted.length > 0) lines.push(`Restarted now: ${change.restarted.join(', ')}.`);
  if (change.afterCall.length > 0) lines.push(`Restarted as soon as the call in progress ends: ${change.afterCall.join(', ')}.`);
  if (change.restarted.length === 0 && change.afterCall.length === 0) lines.push('No MCP server that runs on this machine needed restarting.');
  return lines.join('\n');
}

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
  /** How this app reaches the daemon, which keeps folder trust, the token audit and the sandbox presets. */
  readonly binding: DaemonCapabilityBinding<Ctx>;
  /** This folder's trust as this app holds it (the daemon decides it; the app reads the decision again at once). */
  readonly folder?: {
    /** Read the shared decision again now (after the daemon changed it), so the folder's hooks and servers start or stop. */
    reread(ctx: Ctx): Promise<void>;
    /** False while nothing was decided for this folder; undefined where there is no folder trust. */
    decided(ctx: Ctx): boolean | undefined;
  } | undefined;
  /** The policy-bundle workflow's context (prints through `ctx.print`). */
  readonly policyContext?: ((ctx: Ctx) => PolicyCommandContext) | undefined;
  /**
   * The settings the sandbox actions read, and the one they write. Saving
   * `sandbox.mcpIsolation` restarts the running MCP servers under it; the
   * answer is what that change did, or null where no MCP servers run here.
   */
  readonly sandboxConfig: (ctx: Ctx) => ConfigManagerLike & { setMcpIsolation(mode: 'contained' | 'disabled'): McpIsolationChange | null };
  /** The sandbox session registry, where this app has one. */
  readonly sandboxSessions?: ((ctx: Ctx) => SandboxSessionRegistry | undefined) | undefined;
  readonly resolvePath: (ctx: Ctx, path: string) => string;
  /** Where the parts this app lacks are: "the terminal app (goodvibes)". */
  readonly elsewhere: string;
}

interface SandboxSessionsHolder {
  readonly workspace?: { readonly sandboxSessionRegistry?: Pick<SandboxSessionRegistry, 'list'> | null | undefined } | undefined;
}

/** The sandbox sessions this program started (the list a "Sandbox session" input chooses from). */
defineList<CommandActionContext>({
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
  const sandboxSessionsOf = (ctx: Ctx): SandboxSessionServices => {
    const registry = policy.sandboxSessions?.(ctx);
    if (!registry) return {};
    return {
      sandboxSessions: {
        registry, config: policy.sandboxConfig(ctx), resolvePath: (path) => policy.resolvePath(ctx, path),
        // A model writes a record only inside the working folder.
        insideOnly: ctx.invokedByModel === true,
      },
    };
  };
  /** A folder trust change: this app reads the shared decision again at once, so its hooks and servers follow now. */
  const rereadingFolder = (action: ActionDescription<Ctx>): ActionDescription<Ctx> => ({
    ...action,
    async run(values, ctx) {
      const said = await action.run(values, ctx);
      await policy.folder?.reread(ctx);
      ctx.renderRequest?.();
      return said;
    },
  });
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
    // The daemon's audit of the paired devices' tokens (capabilities/builtin/security.ts).
    daemonCapabilityAction<Ctx>(SECURITY_TOKENS, policy.binding),
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
    // This folder's trust is kept in the shared register; the daemon decides it (capabilities/builtin/security.ts),
    // and this app reads the decision again at once so the folder's own hooks and MCP servers start or stop now.
    daemonCapabilityAction<Ctx>(SECURITY_FOLDER, policy.binding),
    rereadingFolder(daemonCapabilityAction<Ctx>(SECURITY_TRUST_FOLDER, policy.binding)),
    rereadingFolder(daemonCapabilityAction<Ctx>(SECURITY_RESTRICT_FOLDER, policy.binding)),
    {
      id: 'save-trust', label: 'Save the trust summary to a file', word: 'save-trust',
      inputs: [PATH_INPUT('Where to write it; only you can read it'), REPLACE_FILE_INPUT],
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
      // A policy swap may tighten as well as loosen: the line says what is in force, not that it loosened.
      riskDone: 'The candidate is the policy in force now: the calls it decides differently go its way, looser or stricter.',
      ownerOnly: { reason: 'a new policy may allow what the one in force refuses', instead: 'Ask the owner to enforce it: /security enforce-policy.' },
      operator: { terminalOnly: 'The policy registry is the terminal app\'s.' }, example: {},
      async run(_values, ctx) { await runPolicy(ctx, ['promote', '--yes']); },
    },
    {
      id: 'restore-policy', label: 'Go back to the previous policy', word: 'restore-policy', inputs: [],
      sentence: 'The policy in force before the last one is enforced again, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'enforce-policy',
      riskDone: 'The previous policy is in force again: the calls it decides differently go its way, looser or stricter.',
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
    daemonCapabilityAction<Ctx>(SECURITY_SANDBOX_PRESETS, policy.binding),
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
      sentence: 'Each MCP server runs inside its own process boundary, and the running ones are restarted inside it, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'host-mcp',
      operator: { terminalOnly: 'The web UI sets sandbox.mcpIsolation on its settings screen.' }, example: {},
      async run(_values, ctx) {
        const config = policy.sandboxConfig(ctx);
        const change = config.setMcpIsolation('contained');
        return buildSandboxReview(config).host.secureSandboxReady
          ? describeIsolationChange(change, 'MCP servers run inside their own bubblewrap boundary from now on.')
          : 'Saved, but this machine has no bubblewrap: a stdio MCP server will not start until bubblewrap is installed or MCP servers run as host processes again.';
      },
    },
    {
      id: 'host-mcp', label: 'Run MCP servers as host processes', word: 'host-mcp', inputs: [],
      sentence: 'MCP servers run as ordinary processes of this machine, with no boundary, and the running ones are restarted that way, until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'contain-mcp',
      ownerOnly: { reason: 'it takes the process boundary away from MCP servers', instead: 'Ask the owner: /security host-mcp.' },
      operator: { terminalOnly: 'The web UI sets sandbox.mcpIsolation on its settings screen.' }, example: {},
      async run(_values, ctx) {
        return describeIsolationChange(policy.sandboxConfig(ctx).setMcpIsolation('disabled'), 'MCP servers run as host processes from now on.');
      },
    },
    // The sandbox sessions this app started (capabilities/builtin/security.ts): this program's own, run here.
    ...[SECURITY_SANDBOX_SESSIONS, SECURITY_START_SANDBOX, SECURITY_SANDBOX_SESSION, SECURITY_STOP_SANDBOX, SECURITY_RUN_IN_SANDBOX, SECURITY_SAVE_SANDBOX, SECURITY_READ_SANDBOX]
      .map((definition) => sessionCapabilityAction<Ctx, SandboxSessionServices>(definition, sandboxSessionsOf, TERMINAL_SESSIONS)),
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
