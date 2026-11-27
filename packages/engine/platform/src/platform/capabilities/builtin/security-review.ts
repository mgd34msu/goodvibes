/**
 * Security reviews, the policy bundles and the sandbox setting.
 *
 * The daemon's (what it holds for every program on this machine):
 *  - the policy bundles: one activation record, the daemon's, that every program follows. Loading a candidate,
 *    reviewing what it changes, enforcing it and going back are done here; the daemon announces the change and each
 *    program's gate reads its own copy from then on (runtime/permissions/policy-config-loader.ts, terminal-shell
 *    policy-follow.ts);
 *  - the trust summary (what is trusted), saved to a file and read back;
 *  - the sandbox: `sandbox.mcpIsolation` is a setting the daemon writes and every program follows (each restarts
 *    its running MCP servers under it), and the profiles and advice read from it.
 *
 * The program's (its own live state: the MCP servers and plugins its turns use, this terminal's sandbox probe):
 *  - what needs attention, the whole review and the risky routes through MCP servers, each with the daemon's facts
 *    (tokens, policies, this folder's trust) read from the daemon.
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
import type { DeepReadonly } from '../../config/manager.js';
import type { GoodVibesConfig } from '../../config/schema-types.js';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import { dispatchPolicyCommand, type PolicyMcpServerSecurity } from '../../gate/policy/policy-dispatch.js';
import type { PermissionModeInForce } from '../../permissions/decision-model-readiness.js';
import { buildMcpAttackPathReview } from '../../runtime/mcp/permissions.js';
import type { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.js';
import { policyImpact } from '../../runtime/permissions/policy-impact.js';
import {
  buildSandboxReview, inspectSandboxProbe, renderSandboxProfiles, renderSandboxRecommendation, renderSandboxReview, type ConfigManagerLike,
} from '../../runtime/sandbox/manager.js';
import { buildTrustReviewBundle, formatTrustReview, inspectTrustBundle } from '../../security/trust-review.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { readRefusal } from '@goodvibes/engine/errors';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription } from '../types.js';
import { fileWorkRefusal, unreadableFile } from '../path-inputs.js';
import type { SecretsCapabilityServices } from './secrets.js';

type AttackPathInput = Parameters<typeof buildMcpAttackPathReview>[0];

/** What the daemon's security capabilities need. */
export interface SecurityReviewCapabilityServices {
  readonly securityReview: {
    /** The daemon's policy state: the bundle in force, the candidate, the history, the recorded calls; it writes the one activation record. */
    policy(): PolicyRuntimeState;
    /** The settings in force for the asking project (the daemon's with the project's own file over them), as the preflight reads them. */
    config(caller: CapabilityCaller): DeepReadonly<GoodVibesConfig>;
    /** The MCP servers of the asking project, with their trust (the preflight and the trust summary read them). */
    mcpServers(caller: CapabilityCaller): readonly (PolicyMcpServerSecurity & { readonly schemaFreshness: string })[];
    /** The plugins of the asking project, with their trust. */
    plugins(caller: CapabilityCaller): readonly { readonly trustTier: string; readonly quarantined?: boolean | undefined }[];
    /** The services set up. */
    serviceNames(): readonly string[];
    /** The permission mode in force for the asking project, as the gate reads it for a call there. */
    permissionMode(caller: CapabilityCaller): PermissionModeInForce;
    /** The settings the sandbox reads for the asking project: the daemon's, with the project's own file over them. */
    sandboxConfig(caller: CapabilityCaller): ConfigManagerLike;
    /** Write `sandbox.mcpIsolation` on the daemon's settings; every program follows it and restarts its running MCP servers under it. */
    setMcpIsolation(mode: 'contained' | 'disabled'): void;
    /** The daemon's `sandbox.enabled`, which every program follows: commands inside the sandbox, or on the host. */
    setSandboxEnabled(on: boolean): void;
    /** What carrying the programs' own policies into the one record said at upgrade, or null. */
    carriedNote(): string | null;
    /** A path as the asking program means it (against its folder). */
    resolvePath(caller: CapabilityCaller, path: string): string;
    /** Told after the policy in force changed: every program reads the record again. */
    changed(): void;
  };
}

type Daemon = SecurityReviewCapabilityServices & Pick<SecretsCapabilityServices, 'secrets'>;

const daemon = (id: string, repeat: 'safe' | 'unsafe' = 'safe') => ({ id, group: 'safety' as const, home: 'daemon' as const, repeat });
const session = (id: string) => ({ id, group: 'safety' as const, home: 'session' as const, repeat: 'safe' as const });

const PATH = (help: string, position: 1 | 2 = 1): InputDescription => ({
  id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path', required: true, typed: { position },
});
const REPLACE: InputDescription = {
  id: 'replace', label: 'If it exists', help: 'Whether to write over a file that is already there', kind: 'choice',
  choices: [{ value: 'no', label: 'Leave it, write nothing' }, { value: 'yes', label: 'Write over it' }],
  required: { default: 'no', defaultMeans: 'leave an existing file alone' }, typed: { flag: '--replace', switchOn: 'yes' },
};

// ---------------------------------------------------------------------------
// The policy bundles (the daemon's one activation record)
// ---------------------------------------------------------------------------

function policyOf(services: Daemon): PolicyRuntimeState {
  return services.securityReview.policy();
}

/**
 * Who asks, when it is not the owner at large: whether it may reach the things of a project, by its folder (the one
 * reach rule, control-plane/caller-reach.ts); undefined for the owner, who sees every project's recorded calls.
 */
function policyReach(): ((project: string | undefined) => boolean) | undefined {
  const reach = currentRecordReach();
  return reach ? (project) => typeof project === 'string' && project.trim() !== '' && reach('project', project.trim()) : undefined;
}

/** One step of the policy workflow, run on the daemon's policy state; its lines without the workflow's prefix. */
async function policyStep(services: Daemon, caller: CapabilityCaller, args: readonly string[]): Promise<string> {
  const printed: string[] = [];
  const state = policyOf(services);
  try {
    await dispatchPolicyCommand(args, {
      print: (text) => { printed.push(...text.split('\n')); },
      policyRuntimeState: state,
      workingDirectory: () => {
        if (!caller.workingDirectory) throw new CapabilityRefusal('No folder was given: a bundle file is read against the folder of the program that asked.');
        return caller.workingDirectory;
      },
      config: () => services.securityReview.config(caller),
      listMcpServerSecurity: () => services.securityReview.mcpServers(caller),
      // A caller that is not the owner: the candidates and recorded calls of the projects it may reach only.
      ...(policyReach() ? { reach: policyReach() } : {}),
    });
  } catch (error) {
    if (error instanceof CapabilityRefusal) throw error;
    const refused = readRefusal(error);
    if (refused) throw new CapabilityRefusal(`${refused.reason.replace(/\.$/, '')}.`, refused.next?.[0]);
    throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`);
  }
  return printed.map((line) => line.replace(/^\[policy\]\s*/, '')).filter((line) => line.trim() !== '').join('\n');
}

/** The policy in force, the candidate and the history, as a place and a script read them. */
function policyFacts(services: Daemon): Record<string, unknown> {
  const state = policyOf(services);
  const registry = state.getRegistry();
  const current = registry.getCurrent();
  // A candidate is the owner's, loaded from a project's folder: a caller that is not the owner sees it only when it may
  // reach that project (gate/policy/policy-dispatch.ts `visibleCandidate`, the same rule).
  const held = registry.getCandidate();
  const reach = policyReach();
  const candidate = held && (!reach || (held.sourcePath !== undefined && reach(dirname(held.sourcePath)))) ? held : null;
  const snapshot = state.getSnapshot() as { readonly lintFindings?: readonly unknown[]; readonly lastPreflightReview?: { readonly status?: string } | null };
  const note = services.securityReview.carriedNote();
  const problem = state.getConfiguredBundleFailure();
  // The counts are filtered like the rows (a count is information about other projects too): for a caller that is not
  // the owner, the candidate's changes are its reached projects' recorded calls decided again (as its status shows them,
  // gate/policy/policy-dispatch.ts), the lint findings are those of the policy in force and of a candidate it may see,
  // and the preflight review (read over both bundles) only while it may see every bundle it read.
  const changes = !candidate?.impact ? null : !reach ? candidate.impact.changed.length
    : policyImpact({ currentRules: current?.rules ?? [], candidateRules: candidate.rules, projectRoot: dirname(candidate.sourcePath ?? '.'),
      calls: state.getRecentPermissionAudit(), reaches: reach }).changed.length;
  const lint = state.getLintCounts();
  const lintFindings = !reach ? (Array.isArray(snapshot.lintFindings) ? snapshot.lintFindings.length : 0) : lint.current + (candidate ? lint.candidate : 0);
  const preflight = reach && held && !candidate ? null : snapshot.lastPreflightReview?.status ?? null;
  return {
    ...(current ? { current: { id: current.bundle.bundleId, rules: current.rules.length, ...(current.activatedAt ? { since: current.activatedAt } : {}), ...(current.sourcePath ? { file: current.sourcePath } : {}) } } : {}),
    ...(candidate ? { candidate: { id: candidate.bundle.bundleId, rules: candidate.rules.length, state: candidate.state, changes, ...(candidate.sourcePath ? { file: candidate.sourcePath } : {}) } } : {}),
    history: registry.getHistory().length,
    lintFindings,
    preflight,
    ...(problem ? { problem } : {}),
    ...(note ? { carried: note } : {}),
  };
}

export const SECURITY_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.policy'), actionId: 'policy', label: 'See the policy in force', word: 'policy', inputs: [],
  sentence: 'Shows the policy bundle in force on this machine, the candidate waiting, the history and what the candidate would change.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const said = await policyStep(services, caller, ['status']);
    const note = services.securityReview.carriedNote();
    return { text: [said, ...(note ? [`At the upgrade: ${note}`] : [])].join('\n'), data: policyFacts(services) };
  },
};

export const SECURITY_LOAD_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.load-policy', 'unsafe'), actionId: 'load-policy', label: 'Load a candidate policy', word: 'load-policy',
  inputs: [PATH('The policy bundle file')],
  sentence: 'The bundle in {path} becomes the candidate policy until you change it; nothing is enforced until you enforce it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'policy-bundle.json' },
  // The candidate is the owner's (one for the daemon, what "Enforce" puts in force): loading one is the owner's own act, so a
  // device's, a member's or a model's load is put to the owner and never replaces their candidate on its own.
  ownerOnly: { reason: 'the candidate is the one you review and enforce for every program on this machine', instead: 'Ask the owner to load it in Permissions and safety, Policy.' },
  ownersAct: true,
  async run(values, services, caller) {
    const before = policyOf(services).getRegistry().getCandidate();
    // Placed by the one rule for every capability's path (capabilities/path-inputs.ts).
    const path = services.securityReview.resolvePath(caller, values.path!);
    const said = await policyStep(services, caller, ['load', path]);
    const after = policyOf(services).getRegistry().getCandidate();
    // The workflow says a failed load in a line and leaves the candidate as it was: that is a refusal here. Its words can
    // quote the file (a parser's message): only the person reads them.
    if (!after || after === before) throw caller.personAsked === true ? new CapabilityRefusal(said || 'No candidate was loaded.') : unreadableFile(values.path!, 'a policy bundle', caller, undefined, 'No candidate was loaded.');
    services.securityReview.changed();
    return { text: said, data: policyFacts(services) };
  },
};

export const SECURITY_SIMULATE_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.simulate-policy'), actionId: 'simulate-policy', label: 'See what the candidate policy changes', word: 'simulate-policy', inputs: [],
  sentence: 'Decides the calls recorded on this machine again under the candidate and shows each one it decides differently; no model is asked.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const said = await policyStep(services, caller, ['simulate']);
    services.securityReview.changed();
    return { text: said, data: policyFacts(services) };
  },
};

export const SECURITY_COMPARE_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.compare-policy'), actionId: 'compare-policy', label: 'Compare the candidate with the policy in force', word: 'compare-policy', inputs: [],
  sentence: 'Shows the rules the candidate adds, removes, changes and moves.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) { return { text: await policyStep(services, caller, ['diff']) }; },
};

export const SECURITY_LINT_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.lint-policy'), actionId: 'lint-policy', label: 'Check the policies for mistakes', word: 'lint-policy', inputs: [],
  sentence: 'Lints the policy in force and the candidate and lists each finding.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) { return { text: await policyStep(services, caller, ['lint']) }; },
};

export const SECURITY_PREFLIGHT: CapabilityDefinition<Daemon> = {
  capability: daemon('security.preflight'), actionId: 'preflight', label: 'Review policy and MCP risk', word: 'preflight', inputs: [],
  sentence: 'Reviews the policy, the settings and the MCP servers\' trust together and lists each issue.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const said = await policyStep(services, caller, ['preflight']);
    services.securityReview.changed();
    return { text: said, data: policyFacts(services) };
  },
};

export const SECURITY_ENFORCE_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.enforce-policy'), actionId: 'enforce-policy', label: 'Enforce the candidate policy', word: 'enforce-policy', inputs: [],
  sentence: 'The candidate becomes the policy in force in every program on this machine, deciding the calls "See what the candidate policy changes" showed differently, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'restore-policy',
  // A policy swap may tighten as well as loosen: the line says what is in force, not that it loosened.
  riskDone: 'The candidate is the policy in force now: the calls it decides differently go its way, looser or stricter.',
  ownerOnly: { reason: 'a new policy may allow what the one in force refuses', instead: 'Ask the owner to enforce it in Permissions and safety, Policy.' },
  ownersAct: true,
  example: {},
  async run(_values, services, caller) {
    const said = await policyStep(services, caller, ['promote', '--yes']);
    services.securityReview.changed();
    return { text: said, data: policyFacts(services) };
  },
};

export const SECURITY_RESTORE_POLICY: CapabilityDefinition<Daemon> = {
  capability: daemon('security.restore-policy'), actionId: 'restore-policy', label: 'Go back to the previous policy', word: 'restore-policy', inputs: [],
  sentence: 'The policy in force before the last one is enforced again in every program on this machine, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'enforce-policy',
  riskDone: 'The previous policy is in force again: the calls it decides differently go its way, looser or stricter.',
  ownerOnly: { reason: 'the previous policy may allow what the one in force refuses', instead: 'Ask the owner to go back in Permissions and safety, Policy.' },
  ownersAct: true,
  example: {},
  async run(_values, services, caller) {
    const said = await policyStep(services, caller, ['rollback']);
    services.securityReview.changed();
    return { text: said, data: policyFacts(services) };
  },
};

// ---------------------------------------------------------------------------
// What is trusted (the daemon's)
// ---------------------------------------------------------------------------

async function trustBundle(services: Daemon, caller: CapabilityCaller) {
  let secretKeys: readonly string[];
  try {
    secretKeys = [...new Set((await services.secrets.viewFor(caller).listDetailed()).map((record) => record.key))];
  } catch (error) {
    throw new CapabilityRefusal(`Your secrets could not be read, so the trust summary was not made: ${summarizeError(error)}`);
  }
  const review = services.securityReview;
  return buildTrustReviewBundle({
    secretKeys, serviceNames: review.serviceNames(), plugins: review.plugins(caller), mcpServers: review.mcpServers(caller), permissionMode: review.permissionMode(caller),
  });
}

export const SECURITY_TRUST: CapabilityDefinition<Daemon> = {
  capability: daemon('security.trust'), actionId: 'trust', label: 'See what is trusted', word: 'trust', inputs: [],
  sentence: 'Shows the permission mode, how many secrets and services are set up, and how far each plugin and MCP server is trusted.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const bundle = await trustBundle(services, caller);
    return { text: formatTrustReview(bundle), data: { permissionMode: bundle.permissionMode, secrets: bundle.secretKeys.length, services: bundle.serviceNames.length, plugins: bundle.pluginSummary, mcpServers: bundle.mcpSummary } };
  },
};

export const SECURITY_SAVE_TRUST: CapabilityDefinition<Daemon> = {
  capability: daemon('security.save-trust'), actionId: 'save-trust', label: 'Save the trust summary to a file', word: 'save-trust',
  inputs: [{ ...PATH('Where to write it; only you can read it'), file: 'written' }, REPLACE],
  sentence: 'The trust summary (secret names, not values) will be written to {path}, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'trust-review.json' },
  async run(values, services, caller) {
    const target = services.securityReview.resolvePath(caller, values.path!);
    if (existsSync(target) && values.replace !== 'yes') throw new CapabilityRefusal(`${basename(target)} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    const bundle = await trustBundle(services, caller);
    try {
      // Only the owner can read it (0600): the summary lists secret names and service names.
      atomicWriteFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { mkdirp: true });
    } catch (error) {
      throw new CapabilityRefusal(`Nothing was written: ${summarizeError(error)}`);
    }
    return { text: `Saved the trust summary to ${target}.`, data: { path: target } };
  },
};

export const SECURITY_READ_TRUST: CapabilityDefinition<Daemon> = {
  capability: daemon('security.read-trust'), actionId: 'read-trust', label: 'Read a saved trust summary', word: 'read-trust',
  inputs: [PATH('A trust summary saved earlier')],
  sentence: 'Reads the trust summary saved in {path} and shows what it recorded.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'trust-review.json' },
  async run(values, services, caller) {
    const target = services.securityReview.resolvePath(caller, values.path!);
    try {
      return { text: inspectTrustBundle(target) };
    } catch (error) {
      // Never the system's or the parser's words to anyone but the person (capabilities/path-inputs.ts).
      throw fileWorkRefusal(basename(target), 'a trust summary', caller, error, 'Nothing was read from it.');
    }
  },
};

// ---------------------------------------------------------------------------
// The sandbox setting (the daemon's, every program follows it)
// ---------------------------------------------------------------------------

export const SECURITY_SANDBOX: CapabilityDefinition<Daemon> = {
  capability: daemon('security.sandbox'), actionId: 'sandbox', label: 'See the sandbox', word: 'sandbox', inputs: [],
  sentence: 'Shows whether commands and MCP servers run inside a process boundary on this machine, and which backend does it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const config = services.securityReview.sandboxConfig(caller);
    const review = buildSandboxReview(config);
    return {
      text: renderSandboxReview(config),
      data: {
        commands: config.get('sandbox.enabled') === false ? 'host' : 'contained', mcpIsolation: review.config.mcpIsolation,
        backend: review.backendProbe?.resolvedBackend ?? 'host', containment: review.host.secureSandboxReady, warnings: [...review.host.warnings],
      },
    };
  },
};

export const SECURITY_SANDBOX_ADVICE: CapabilityDefinition<Daemon> = {
  capability: daemon('security.sandbox-advice'), actionId: 'sandbox-advice', label: 'See what the sandbox should be', word: 'sandbox-advice', inputs: [],
  sentence: 'Says what to set for the sandbox on this machine, and why.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) { return { text: renderSandboxRecommendation(services.securityReview.sandboxConfig(caller)) }; },
};

export const SECURITY_SANDBOX_PROFILES: CapabilityDefinition<Daemon> = {
  capability: daemon('security.sandbox-profiles'), actionId: 'sandbox-profiles', label: 'See the sandbox profiles', word: 'sandbox-profiles', inputs: [],
  sentence: 'Lists the sandbox profiles (commands, MCP servers) with what each may reach and the backend that runs it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) { return { text: renderSandboxProfiles(services.securityReview.sandboxConfig(caller)) }; },
};

export const SECURITY_CONTAIN_MCP: CapabilityDefinition<Daemon> = {
  capability: daemon('security.contain-mcp'), actionId: 'contain-mcp', label: 'Run MCP servers inside the sandbox', button: 'Contain them', word: 'contain-mcp', inputs: [],
  sentence: 'Each MCP server runs inside its own process boundary in every program on this machine, and the running ones are restarted inside it, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'host-mcp', tightens: true, example: {},
  async run(_values, services, caller) {
    const review = services.securityReview;
    try { review.setMcpIsolation('contained'); } catch (error) { throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`); }
    review.changed();
    const ready = buildSandboxReview(review.sandboxConfig(caller)).host.secureSandboxReady;
    return {
      text: ready
        ? 'MCP servers run inside their own bubblewrap boundary from now on; each program restarts its running ones inside it.'
        : 'Saved, but this machine has no bubblewrap: a stdio MCP server will not start until bubblewrap is installed or MCP servers run as host processes again.',
      data: { mcpIsolation: 'contained', containment: ready },
    };
  },
};

export const SECURITY_HOST_MCP: CapabilityDefinition<Daemon> = {
  capability: daemon('security.host-mcp'), actionId: 'host-mcp', label: 'Run MCP servers as host processes', button: 'Run them on the host', word: 'host-mcp', inputs: [],
  sentence: 'MCP servers run as ordinary processes of this machine, with no boundary, in every program on this machine, and the running ones are restarted that way, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'contain-mcp',
  ownerOnly: { reason: 'it takes the process boundary away from MCP servers', instead: 'Ask the owner to change it in Permissions and safety, Sandbox.' },
  example: {},
  async run(_values, services) {
    try { services.securityReview.setMcpIsolation('disabled'); } catch (error) { throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`); }
    services.securityReview.changed();
    return { text: 'MCP servers run as host processes from now on; each program restarts its running ones that way.', data: { mcpIsolation: 'disabled' } };
  },
};

export const SECURITY_CONTAIN_COMMANDS: CapabilityDefinition<Daemon> = {
  capability: daemon('security.contain-commands'), actionId: 'contain-commands', label: 'Run commands inside the sandbox', button: 'Contain them', word: 'contain-commands', inputs: [],
  sentence: 'Switches the command sandbox on, or back on: each command a tool runs goes inside the sandbox where this machine has one (the folder writable, the rest read-only, no network), in every program on this machine from its next start, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'host-commands', tightens: true, example: {},
  async run(_values, services, caller) {
    const review = services.securityReview;
    try { review.setSandboxEnabled(true); } catch (error) { throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`); }
    review.changed();
    const ready = buildSandboxReview(review.sandboxConfig(caller)).host.secureSandboxReady;
    return {
      text: ready
        ? 'Commands run inside the sandbox from each program\'s next start.'
        : 'Saved, but this machine has no bubblewrap: commands keep running on the host until it is installed.',
      data: { commands: 'contained', containment: ready },
    };
  },
};

export const SECURITY_HOST_COMMANDS: CapabilityDefinition<Daemon> = {
  capability: daemon('security.host-commands'), actionId: 'host-commands', label: 'Run commands on the host, with no sandbox', button: 'Run them on the host', word: 'host-commands', inputs: [],
  sentence: 'Commands run as ordinary processes of this machine, with no boundary (they can write anywhere you can and reach the network), in every program on this machine, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'contain-commands',
  ownerOnly: { reason: 'it takes the sandbox away from every command', instead: 'Ask the owner to change it in Permissions and safety, Sandbox setting.' },
  example: {},
  async run(_values, services) {
    try { services.securityReview.setSandboxEnabled(false); } catch (error) { throw new CapabilityRefusal(`Nothing was changed: ${summarizeError(error)}`); }
    services.securityReview.changed();
    return { text: 'Commands run on the host, with no sandbox, from now on.', data: { commands: 'host' } };
  },
};

export const SECURITY_REVIEW_DAEMON_CAPABILITIES = [
  SECURITY_POLICY, SECURITY_LOAD_POLICY, SECURITY_SIMULATE_POLICY, SECURITY_COMPARE_POLICY, SECURITY_LINT_POLICY, SECURITY_PREFLIGHT,
  SECURITY_ENFORCE_POLICY, SECURITY_RESTORE_POLICY,
  SECURITY_TRUST, SECURITY_SAVE_TRUST, SECURITY_READ_TRUST,
  SECURITY_SANDBOX, SECURITY_SANDBOX_ADVICE, SECURITY_SANDBOX_PROFILES, SECURITY_CONTAIN_MCP, SECURITY_HOST_MCP,
  SECURITY_CONTAIN_COMMANDS, SECURITY_HOST_COMMANDS,
] as const;

// ---------------------------------------------------------------------------
// The program's: what needs attention, the whole review, risky routes, the probe
// ---------------------------------------------------------------------------

/** The daemon's facts a review names, as the program read them from the daemon (or why it could not). */
export interface SecurityDaemonFacts {
  readonly tokens: { readonly total: number; readonly blocked: number; readonly outOfScope: number; readonly overdue: number; readonly dueSoon: number } | { readonly unreadable: string };
  readonly policy: { readonly lintFindings: number; readonly preflight: string | null } | { readonly unreadable: string };
  /** Undefined where the daemon could not say. */
  readonly folderDecided?: boolean | undefined;
}

/** What the program's reviews need: its own live state, and the daemon's facts read through it. */
export interface SecurityHereServices {
  readonly securityHere?: {
    /** The MCP servers this program's turns use now, and the calls they were recently decided on. */
    mcp(): { readonly servers: AttackPathInput['servers']; readonly recentDecisions: AttackPathInput['recentDecisions'] };
    /** The plugins this program runs. */
    plugins(): readonly { readonly trustTier: string; readonly quarantined?: boolean | undefined }[];
    /** This program's model subscriptions. */
    subscriptions(): { readonly active: number; readonly pending: number };
    /** Tokens, policies and this folder's trust, from the daemon. */
    daemonFacts(): Promise<SecurityDaemonFacts>;
    /** The settings this program's sandbox reads (it follows the daemon's `sandbox.mcpIsolation`). */
    readonly sandboxConfig: ConfigManagerLike;
  } | undefined;
}

function here(services: SecurityHereServices): NonNullable<SecurityHereServices['securityHere']> {
  if (!services.securityHere) throw new CapabilityRefusal('This program keeps no security review of its own.');
  return services.securityHere;
}

export const SECURITY_REPORT: CapabilityDefinition<SecurityHereServices> = {
  capability: session('security.report'), actionId: 'report', label: 'See what needs attention', word: 'report', inputs: [],
  sentence: 'Checks paired-device tokens, the policies, MCP servers and their routes, plugins and this folder\'s trust, and names each thing that needs attention and where it is fixed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services): Promise<CapabilityResult> {
    const live = here(services);
    const facts = await live.daemonFacts();
    const items: string[] = [];
    if ('unreadable' in facts.tokens) items.push(`The paired devices' tokens could not be read: ${facts.tokens.unreadable}.`);
    else {
      if (facts.tokens.blocked > 0) items.push(`${facts.tokens.blocked} paired-device token(s) are blocked from use: Permissions and safety, Device tokens.`);
      if (facts.tokens.outOfScope > 0) items.push(`${facts.tokens.outOfScope} paired-device token(s) reach beyond their policy: Permissions and safety, Device tokens.`);
      if (facts.tokens.overdue > 0) items.push(`${facts.tokens.overdue} paired-device token(s) are overdue for rotation: pair the device again in Devices and network.`);
    }
    if ('unreadable' in facts.policy) items.push(`The policies could not be read: ${facts.policy.unreadable}.`);
    else {
      if (facts.policy.lintFindings > 0) items.push(`The policies have ${facts.policy.lintFindings === 1 ? 'a lint finding' : `${facts.policy.lintFindings} lint findings`}: "Check the policies for mistakes" in Permissions and safety, Policy.`);
      if (facts.policy.preflight && facts.policy.preflight !== 'pass') items.push(`The last policy review says ${facts.policy.preflight}: "Review policy and MCP risk" in Permissions and safety, Policy.`);
    }
    const mcp = live.mcp();
    const review = buildMcpAttackPathReview({ servers: mcp.servers, recentDecisions: mcp.recentDecisions });
    const quarantined = mcp.servers.filter((server) => server.schemaFreshness === 'quarantined').length;
    if (quarantined > 0) items.push(`${quarantined} MCP server(s) have tools held back for review: Tools and extensions, MCP servers.`);
    const elevated = mcp.servers.filter((server) => server.trustMode === 'allow-all').length;
    if (elevated > 0) items.push(`${elevated} MCP server(s) may run any tool without asking: choose what they may do in Tools and extensions, MCP servers.`);
    if (review.findings.length > 0) items.push(`${review.findings.length} risky route(s) through MCP servers (${review.summary}): "See risky routes through MCP servers".`);
    const held = live.plugins().filter((plugin) => plugin.quarantined).length;
    if (held > 0) items.push(`${held} plugin(s) are held back: Tools and extensions, Plugins.`);
    if (facts.folderDecided === false) items.push('Nothing was decided yet about trusting this folder: Permissions and safety, This folder.');
    if (items.length === 0) return { text: 'Nothing needs attention.', data: { attention: 0 } };
    if (items.length === 1) return { text: `1 thing needs attention. ${items[0]}`, data: { attention: 1 } };
    return { text: [`${items.length} things need attention:`, ...items.map((item) => `- ${item}`)].join('\n'), data: { attention: items.length } };
  },
};

export const SECURITY_REVIEW: CapabilityDefinition<SecurityHereServices> = {
  capability: session('security.review'), actionId: 'review', label: 'See the whole security review', word: 'review', inputs: [],
  sentence: 'Shows every count the review reads: tokens, subscriptions, policy findings, MCP servers and their routes, and plugins.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const live = here(services);
    const facts = await live.daemonFacts();
    const mcp = live.mcp();
    const review = buildMcpAttackPathReview({ servers: mcp.servers, recentDecisions: mcp.recentDecisions });
    const plugins = live.plugins();
    const subscriptions = live.subscriptions();
    const tokens = 'unreadable' in facts.tokens
      ? [`  paired-device tokens: could not be read (${facts.tokens.unreadable})`]
      : [
        `  paired-device tokens: ${facts.tokens.total}`, `  blocked tokens: ${facts.tokens.blocked}`, `  tokens past their policy: ${facts.tokens.outOfScope}`,
        `  rotation overdue: ${facts.tokens.overdue}`, `  rotation due soon: ${facts.tokens.dueSoon}`,
      ];
    const policy = 'unreadable' in facts.policy
      ? [`  policies: could not be read (${facts.policy.unreadable})`]
      : [`  policy lint findings: ${facts.policy.lintFindings}`, `  policy review: ${facts.policy.preflight ?? 'not run'}`];
    return {
      text: [
        'Security review',
        ...tokens,
        `  built-in subscription providers: ${listBuiltinSubscriptionProviders().length}`,
        `  active subscriptions: ${subscriptions.active}`,
        `  pending subscriptions: ${subscriptions.pending}`,
        ...policy,
        `  MCP servers: ${mcp.servers.length}`,
        `  MCP servers with tools held back: ${mcp.servers.filter((server) => server.schemaFreshness === 'quarantined').length}`,
        `  MCP servers that run any tool without asking: ${mcp.servers.filter((server) => server.trustMode === 'allow-all').length}`,
        `  risky routes through MCP servers: ${review.findings.length}`,
        `  plugins held back: ${plugins.filter((plugin) => plugin.quarantined).length}`,
        `  untrusted plugins: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
      ].join('\n'),
    };
  },
};

export const SECURITY_ATTACK_PATHS: CapabilityDefinition<SecurityHereServices> = {
  capability: session('security.attack-paths'), actionId: 'attack-paths', label: 'See risky routes through MCP servers', word: 'attack-paths', inputs: [],
  sentence: 'Shows the routes by which an MCP server could reach files, the network or other tools further than its trust allows.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const mcp = here(services).mcp();
    const review = buildMcpAttackPathReview({ servers: mcp.servers, recentDecisions: mcp.recentDecisions });
    if (review.findings.length === 0) return { text: 'No risky routes through MCP servers.', data: { routes: 0 } };
    return {
      text: [
        'Risky routes through MCP servers',
        `  summary: ${review.summary}`,
        ...review.findings.slice(0, 12).map((finding) => `  ${finding.severity.toUpperCase()} ${finding.serverName}  ${finding.route}\n    ${finding.reason}`),
      ].join('\n'),
      data: { routes: review.findings.length },
    };
  },
};

export const SECURITY_SANDBOX_PROBE: CapabilityDefinition<SecurityHereServices> = {
  capability: session('security.sandbox-probe'), actionId: 'sandbox-probe', label: 'Probe the sandbox on this machine', word: 'sandbox-probe', inputs: [],
  sentence: 'Probes which process boundary this terminal\'s machine can run now, with any warnings.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const review = buildSandboxReview(here(services).sandboxConfig);
    return {
      text: [
        inspectSandboxProbe({
          version: 1, checkedAt: Date.now(), host: review.host.platform,
          currentBackend: review.backendProbe?.resolvedBackend ?? 'host', mcpIsolation: review.config.mcpIsolation,
          secureSandboxReady: review.host.secureSandboxReady, recommendedCommand: '"See what the sandbox should be", in Permissions and safety, Sandbox',
        }),
        ...review.host.warnings.map((warning) => `  warning: ${warning}`),
      ].join('\n'),
      data: { backend: review.backendProbe?.resolvedBackend ?? 'host', containment: review.host.secureSandboxReady },
    };
  },
};

export const SECURITY_REVIEW_SESSION_CAPABILITIES = [SECURITY_REPORT, SECURITY_REVIEW, SECURITY_ATTACK_PATHS, SECURITY_SANDBOX_PROBE] as const;
