/**
 * sandbox.ts, per-command OS-level execution boundary for the exec tool,
 * backed by bubblewrap (`bwrap`) on Linux.
 *
 * GOAL. Shrink the approval tail: a command that runs inside a real OS boundary
 *, workspace writable, the rest of the filesystem read-only, /tmp isolated,
 * network off unless explicitly allowed, is far less able to do harm outside
 * that boundary, so the permission layer can auto-allow it (see
 * runtime/permissions/sandbox-policy.ts) instead of prompting. This module is
 * the RUNNER half: honest availability detection, pure bwrap-argv construction,
 * and a per-command plan. It composes with the existing credential-env scrub
 * (credential-env.ts) rather than replacing it, the scrubbed env is what bwrap
 * hands to the child.
 *
 * HONESTY. Detection never claims a boundary it cannot deliver. No bwrap (or a
 * non-Linux host) → the feature reports unavailable with a stated reason and the
 * caller runs the byte-for-byte-unchanged non-sandboxed exec path. When bwrap is
 * present but a host-level probe cannot confirm that `--unshare-net` yields a
 * real, empty network namespace (e.g. a container without CAP_NET_ADMIN), the
 * sandbox is reported unavailable: every boundary run adds `--unshare-net`, so
 * offering it would turn each command into a bwrap error.
 *
 * NOT a permission decision and NOT the catastrophic block. The catastrophic
 * reading (rm -rf /, dd to a device, mkfs, fork bomb …) belongs to the
 * permission gate, which reads it before a command reaches this module and
 * applies it the same INSIDE the sandbox: a boundary is not a licence for a
 * catastrophic command.
 */

import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { type CommandNeeds } from '../../runtime/permissions/normalization/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideSandboxedExec, egressAllowed, readCommandNeeds } from '../../runtime/permissions/sandbox-policy.js';
import { DEFAULT_CONTROL_PLANE_PORT } from '../../config/control-plane-base-url.js';
import type { ExecCommandResult } from './schema.js';

// The one reading of the text an exec entry runs; an approval reader judges the same text.
export { execCommandText } from './schema.js';

/** Operator-facing per-command exec sandbox configuration (`sandbox.*`). */
export interface ExecSandboxConfig {
  /** Master switch. Default false, the sandbox is off unless explicitly enabled. */
  readonly enabled: boolean;
  /**
   * Command base names (e.g. `curl`, `git`, or `*` for all) whose network access
   * is re-enabled inside the boundary as a NAMED escalation. Empty → the sandbox
   * disables network for every command.
   */
  readonly egressAllowlist: readonly string[];
  /**
   * Absolute paths outside the workspace that are bound writable into the
   * boundary as a NAMED escalation. Empty → only the workspace (and an isolated
   * /tmp) is writable.
   */
  readonly workspaceWritable: readonly string[];
  /**
   * The port the daemon listens on (`controlPlane.port`), named in the
   * isolation note so it matches the refused connection. Absent → the default port.
   */
  readonly daemonPort?: number | undefined;
  /**
   * Hand-edited list entries the settings rule rejected and the sandbox left out,
   * each with the reason, so the result says why a listed command has no network.
   */
  readonly ignoredEntries?: readonly string[] | undefined;
}

/** The honest, host-probed availability of the exec sandbox backend. */
export interface SandboxAvailability {
  readonly available: boolean;
  readonly backend: 'bubblewrap' | 'none';
  /** Resolved `bwrap` path when available. */
  readonly bwrapPath?: string | undefined;
  /** Stated reason, a diagnosis when unavailable, a one-line summary when available. */
  readonly reason: string;
  /**
   * Whether a `--unshare-net` boundary is trustworthy on THIS host. False when
   * bwrap is present but a trivial net-unshare probe did not succeed (so a
   * "network disabled" claim would be unproven), surfaced as `network: 'unknown'`.
   */
  readonly networkIsolationGuaranteed: boolean;
}

/**
 * The raw host-probe inputs detection reasons over. Kept as plain data so
 * {@link detectSandboxAvailability} is pure and unit-testable; production wires
 * the real probe in {@link probeSandboxHost}.
 */
export interface SandboxHostProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** Resolved `bwrap` path, or null when not on PATH. */
  readonly bwrapPath: string | null;
  /** A trivial `bwrap --ro-bind / / /bin/true`-style run exited 0. */
  readonly bwrapWorks: boolean;
  /** A trivial `bwrap --unshare-net --ro-bind / / /bin/true`-style run exited 0. */
  readonly netUnshareWorks: boolean;
}

/**
 * Decide availability from a host probe. Pure. macOS and any non-Linux host are
 * reported unavailable this release (bubblewrap is Linux-only and no
 * sandbox-exec equivalent is wired), never faked.
 */
export function detectSandboxAvailability(probe: SandboxHostProbe): SandboxAvailability {
  if (probe.platform !== 'linux') {
    return {
      available: false,
      backend: 'none',
      reason:
        `per-command exec sandbox unavailable: bubblewrap is Linux-only and no sandbox-exec ` +
        `equivalent is wired this release (host platform: ${probe.platform})`,
      networkIsolationGuaranteed: false,
    };
  }
  if (!probe.bwrapPath) {
    return {
      available: false,
      backend: 'none',
      reason: 'per-command exec sandbox unavailable: bubblewrap (bwrap) was not found on PATH',
      networkIsolationGuaranteed: false,
    };
  }
  if (!probe.bwrapWorks) {
    return {
      available: false,
      backend: 'none',
      bwrapPath: probe.bwrapPath,
      reason:
        `per-command exec sandbox unavailable: bubblewrap is installed (${probe.bwrapPath}) but a ` +
        `trivial sandbox probe failed, unprivileged user namespaces are likely disabled on this host`,
      networkIsolationGuaranteed: false,
    };
  }
  if (!probe.netUnshareWorks) {
    return {
      available: false,
      backend: 'none',
      bwrapPath: probe.bwrapPath,
      reason:
        `per-command exec sandbox unavailable: bubblewrap works (${probe.bwrapPath}) but cannot create a network namespace ` +
        `(--unshare-net failed), which every sandboxed command needs; the host may lack CAP_NET_ADMIN`,
      networkIsolationGuaranteed: false,
    };
  }
  return {
    available: true,
    backend: 'bubblewrap',
    bwrapPath: probe.bwrapPath,
    reason: `bubblewrap sandbox available (${probe.bwrapPath}); network isolation confirmed`,
    networkIsolationGuaranteed: true,
  };
}

/** Pure inputs for {@link buildBwrapArgv}. */
export interface BwrapArgvInput {
  readonly bwrapPath: string;
  /** Absolute workspace path, bound read-write (read-only with `readOnlyWorkspace`). */
  readonly workspaceDir: string;
  /** Bind the workspace read-only: a contained program that may change nothing (runtime/sandbox/contained-spawn.ts). */
  readonly readOnlyWorkspace?: boolean | undefined;
  /** Absolute working directory for the child (chdir'd into the boundary). */
  readonly cwd: string;
  /** Extra absolute paths bound read-write. */
  readonly writableExtras: readonly string[];
  /** When true, the child keeps host network; when false, `--unshare-net`. */
  readonly networkEnabled: boolean;
  /** When set, the home directory is masked with a tmpfs (hidden, not just read-only). */
  readonly maskHomeDir?: string | undefined;
  /** Extra absolute paths bound read-only, after the home mask (a program installed under $HOME). */
  readonly readOnlyExtras?: readonly string[] | undefined;
  /** Resolved regular DNS configuration file when /etc/resolv.conf points into /run. */
  readonly resolverConfigPath?: string | undefined;
}

/**
 * Construct the bwrap argument vector to PREPEND to `['/bin/sh','-c',cmd]`. Pure.
 *
 * System executables, libraries and configuration are bound read-only; host
 * runtime directories and service sockets are absent. The workspace and any
 * writable extras are bound read-write. Network is
 * unshared unless explicitly enabled. The env is NOT set here, the caller hands
 * bwrap the already-credential-scrubbed environment, which bwrap passes through.
 */
export function buildBwrapArgv(input: BwrapArgvInput): string[] {
  const argv: string[] = [input.bwrapPath];
  // A read-only root still exposes connectable Unix sockets. Start with bwrap's
  // empty root and admit the system files needed to execute commands instead.
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
    argv.push('--ro-bind-try', path, path);
  }
  argv.push('--dev', '/dev');
  argv.push('--proc', '/proc');
  // … isolated /tmp …
  argv.push('--tmpfs', '/tmp');
  argv.push('--tmpfs', '/run', '--dir', '/var', '--symlink', '/run', '/var/run', '--tmpfs', '/var/tmp');
  if (input.resolverConfigPath) argv.push('--ro-bind', input.resolverConfigPath, input.resolverConfigPath);
  // … optionally mask $HOME so its contents are hidden, not merely read-only …
  if (input.maskHomeDir) {
    argv.push('--tmpfs', input.maskHomeDir);
  }
  for (const extra of input.readOnlyExtras ?? []) {
    argv.push('--ro-bind-try', extra, extra);
  }
  // … then carve the writable workspace + extras back in (bound LAST so they win).
  argv.push(input.readOnlyWorkspace === true ? '--ro-bind' : '--bind', input.workspaceDir, input.workspaceDir);
  for (const extra of input.writableExtras) {
    argv.push('--bind', extra, extra);
  }
  if (!input.networkEnabled) {
    argv.push('--unshare-net');
  }
  argv.push('--unshare-pid');
  argv.push('--unshare-uts');
  argv.push('--unshare-ipc');
  argv.push('--die-with-parent');
  argv.push('--new-session');
  argv.push('--chdir', input.cwd);
  argv.push('--');
  return argv;
}

/**
 * The DNS configuration file to bind into a boundary that keeps the network:
 * /etc/resolv.conf often points into /run, which a boundary replaces with an
 * empty tmpfs. Undefined when it does not.
 */
export function runResolverConfigPath(): string | undefined {
  try {
    const path = realpathSync('/etc/resolv.conf');
    if (path.startsWith('/run/') && statSync(path).isFile()) return path;
  } catch { /* Hosts without resolv.conf keep their existing resolver behavior. */ }
  return undefined;
}

/** Where the boundary sits on network access for a given command. */
export type SandboxNetworkState = 'disabled' | 'enabled' | 'unknown';

/** The resolved per-command plan the exec runtime acts on. */
export interface ExecSandboxPlan {
  /** True when the command will actually run inside a bwrap boundary. */
  readonly sandboxed: boolean;
  /** argv to prepend to `['/bin/sh','-c',cmd]`; empty when not sandboxed. */
  readonly argvPrefix: string[];
  /** One-line human summary of the boundary (or why there is none). */
  readonly boundary: string;
  /** Network posture for this command inside the boundary. */
  readonly network: SandboxNetworkState;
  /** Named host-access grants applied to this run (network, writable extras). */
  readonly escalationsGranted: string[];
  /**
   * Whether $HOME was masked with a tmpfs for this run. Recorded so the context
   * note claims the mask only when it actually applied, a note that overstates
   * the boundary is the same defect as one that hides it.
   *
   * Optional so adding it does not break a consumer that builds a plan itself;
   * absent is read as "not masked", which is the claim-nothing default.
   */
  readonly homeMasked?: boolean | undefined;
  /** The daemon port the context note names; absent → the default port. */
  readonly daemonPort?: number | undefined;
  /** Present when the sandbox was requested but the host cannot provide it. */
  readonly unavailableReason?: string | undefined;
  /** Sandbox list entries ignored for this run, each with the reason (see ExecSandboxConfig.ignoredEntries). */
  readonly ignoredSettings?: readonly string[] | undefined;
}

/** Inputs to {@link resolveExecSandboxPlan}. */
export interface ResolveSandboxPlanInput {
  readonly config: ExecSandboxConfig;
  readonly availability: SandboxAvailability;
  /** Whether the exec-sandbox capability gate is on (sandbox.enabled). */
  readonly featureEnabled: boolean;
  readonly command: string;
  readonly workspaceDir: string;
  readonly cwd: string;
  readonly homeDir?: string | undefined;
  /** What host access the command needs, read by Jev (readCommandNeeds). */
  readonly needs: CommandNeeds;
}

const NOT_SANDBOXED_ARGV: string[] = [];

/** Needs for a command the sandbox will not wrap: nothing to open, nothing read. */
const NO_NEEDS: CommandNeeds = { needsNetwork: false, needsPrivilege: false };

/**
 * Resolve the per-command sandbox plan. When the capability gate is off, the config
 * switch is off, or the host cannot provide a boundary, returns a not-sandboxed
 * plan (the caller then runs today's unchanged exec path). Otherwise returns the
 * bwrap argv prefix plus honest boundary/network/escalation metadata.
 */
export function resolveExecSandboxPlan(input: ResolveSandboxPlanInput): ExecSandboxPlan {
  if (!input.featureEnabled || !input.config.enabled) {
    return {
      sandboxed: false,
      argvPrefix: NOT_SANDBOXED_ARGV,
      boundary: 'no sandbox: per-command exec sandbox is not enabled',
      network: 'enabled',
      escalationsGranted: [],
      homeMasked: false,
    };
  }
  if (!input.availability.available || !input.availability.bwrapPath) {
    return {
      sandboxed: false,
      argvPrefix: NOT_SANDBOXED_ARGV,
      boundary: `no sandbox: ${input.availability.reason}`,
      network: 'enabled',
      escalationsGranted: [],
      homeMasked: false,
      unavailableReason: input.availability.reason,
    };
  }

  // The owner's list names whole commands: network is shared only when every
  // command in the line is listed, so a listed word cannot carry another program.
  const networkEnabled = input.needs.needsNetwork === true && egressAllowed(input.command, input.config.egressAllowlist);

  const escalationsGranted: string[] = [];
  if (networkEnabled) {
    escalationsGranted.push('network (command on egress allowlist)');
  }
  for (const extra of input.config.workspaceWritable) {
    escalationsGranted.push(`writable path outside workspace: ${extra}`);
  }

  const network: SandboxNetworkState = networkEnabled
    ? 'enabled'
    : input.availability.networkIsolationGuaranteed
      ? 'disabled'
      : 'unknown';

  const resolverConfigPath = runResolverConfigPath();
  const argvPrefix = buildBwrapArgv({
    bwrapPath: input.availability.bwrapPath,
    workspaceDir: input.workspaceDir,
    cwd: input.cwd,
    writableExtras: input.config.workspaceWritable,
    networkEnabled,
    resolverConfigPath,
    ...(input.homeDir ? { maskHomeDir: input.homeDir } : {}),
  });

  const networkSummary =
    network === 'enabled' ? 'network allowed' : network === 'disabled' ? 'network disabled' : 'network isolation unconfirmed';
  const boundary =
    `bubblewrap: workspace ${input.workspaceDir} writable, system read-only, /tmp isolated, ${networkSummary}`;

  const ignoredSettings = input.config.ignoredEntries ?? [];
  return {
    sandboxed: true, argvPrefix, boundary, network, escalationsGranted, homeMasked: input.homeDir !== undefined,
    ...(input.config.daemonPort === undefined ? {} : { daemonPort: input.config.daemonPort }),
    ...(ignoredSettings.length > 0 ? { ignoredSettings } : {}),
  };
}

/** A host-owned, exact-plan admission; never an instruction to widen containment. */
export interface SandboxEscalationRequest {
  readonly command: string;
  readonly escalations: readonly string[];
  readonly boundary: string;
  readonly policyReasons: readonly string[];
  readonly workingDirectory?: string | undefined;
  readonly plan?: Readonly<ExecSandboxPlan> | undefined;
}
export interface SandboxEscalationExecution {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export interface SandboxEscalationPermit {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly claim: () => void;
  readonly close: () => void;
}
export type SandboxEscalationHandler = (input: SandboxEscalationRequest,
  execution?: SandboxEscalationExecution) => Promise<boolean | SandboxEscalationPermit>;

/**
 * The resolved sandbox context the exec runtime threads per call: the config,
 * the host availability, and whether the graduation-gated flag is on. Null on a
 * createExecTool with no sandbox wiring, then every command runs the unchanged
 * non-sandboxed path.
 */
export interface ExecSandboxRuntime {
  readonly config: ExecSandboxConfig;
  readonly availability: SandboxAvailability;
  readonly featureEnabled: boolean;
  readonly homeDir?: string | undefined;
  /**
   * Broker a sandbox host-access escalation ask (network, host-privilege
   * escalation) through the approval broker before the command runs. Wired at
   * the composition root to the sandbox-escalation seam. Returns true when
   * approved. When absent, escalations are not asked (today's behavior); the
   * permission gate's catastrophic reading is made before the runtime runs
   * and is unaffected.
   */
  /**
   * Invoked each time a command actually runs inside the boundary. Wired at
   * the composition root to the announce-once containment receipt ("commands
   * now run contained; escalations will ask"), the announcer keeps the
   * once-semantics, this seam just reports the runs.
   */
  readonly onSandboxedRun?: (() => void) | undefined;
  readonly requestEscalation?: SandboxEscalationHandler | undefined;
}

/**
 * Resolve the per-command plan from a threaded runtime context. Returns null
 * when there is no sandbox wiring at all, so the caller can skip both the argv
 * wrapping and the result metadata entirely (byte-for-byte today's behavior).
 */
export async function resolveRuntimeSandboxPlan(
  sandbox: ExecSandboxRuntime | null,
  command: string,
  workspaceDir: string,
  cwd: string,
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {},
): Promise<ExecSandboxPlan | null> {
  if (!sandbox) return null;
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  // The network is opened only for a command Jev reads as needing it AND whose
  // every command the owner listed (resolveExecSandboxPlan ANDs the two). The
  // allowlist alone never opens it: `*` or a listed `git` must not give a
  // command that needs no network the host network. A Classic fallback reads
  // no need (null), so the network stays closed.
  const needs = await readCommandNeeds(command, workspaceDir, options);
  return resolveExecSandboxPlan({
    needs,
    config: sandbox.config,
    availability: sandbox.availability,
    featureEnabled: sandbox.featureEnabled,
    command,
    workspaceDir,
    cwd,
    ...(sandbox.homeDir ? { homeDir: sandbox.homeDir } : {}),
  });
}

/**
 * Broker a sandbox host-access escalation ask through the injected
 * `requestEscalation` seam BEFORE the command runs. Returns the named
 * escalations when the ask was DENIED (the caller then denies the command), or
 * a live admission to claim immediately before spawning, or null for no ask /
 * legacy direct approval. The permission gate's catastrophic reading is made
 * before this runs and is untouched here; this only ever gates the host-access
 * escalation, never the command class.
 */
export async function brokerSandboxEscalation(
  sandbox: ExecSandboxRuntime | null,
  plan: ExecSandboxPlan | null,
  command: string,
  workingDirectory: string,
  execution?: SandboxEscalationExecution,
): Promise<{ deniedEscalations: string[] } | { admission: SandboxEscalationPermit } | null> {
  if (!plan?.sandboxed) return null;
  // A null return means this command WILL run inside the boundary, report it
  // so the wired announcer can turn the first contained run into the one-time
  // "commands now run contained; escalations will ask" line.
  const reportContainedRun = (): null => {
    sandbox?.onSandboxedRun?.();
    return null;
  };
  if (!sandbox?.requestEscalation) return reportContainedRun();
  const revision = JSON.stringify({ plan, config: sandbox.config, availability: sandbox.availability, featureEnabled: sandbox.featureEnabled });
  const assertCurrent = () => {
    execution?.signal?.throwIfAborted(); execution?.assertCurrent();
    if (revision !== JSON.stringify({ plan, config: sandbox.config, availability: sandbox.availability, featureEnabled: sandbox.featureEnabled })) throw new Error('Sandbox plan or policy changed');
  };
  const decision = decideSandboxedExec({
    command,
    // The plan already holds the grant (Jev's need AND the owner's allowlist); ask only when it opened the network.
    needs: { needsNetwork: plan.network === 'enabled', needsPrivilege: false },
    sandboxActive: true,
    egressAllowlist: sandbox.config.egressAllowlist,
    baseEffectWhenNotSandboxed: 'ask',
  });
  if (decision.effect !== 'ask' || decision.escalations.length === 0) return reportContainedRun();
  // This is the one place the owner is asked for this escalation: inside the call that runs the command,
  // with its exact plan. An approval gate in front of exec leaves it here (decision.askedAtRun).
  assertCurrent();
  const approved = await sandbox.requestEscalation(Object.freeze({
    command,
    escalations: Object.freeze([...decision.escalations]),
    boundary: plan.boundary,
    policyReasons: Object.freeze([decision.reason]),
    workingDirectory,
    plan: Object.freeze({ ...plan, argvPrefix: Object.freeze([...plan.argvPrefix]) as unknown as string[], escalationsGranted: Object.freeze([...plan.escalationsGranted]) as unknown as string[] }),
  }), { signal: execution?.signal, assertCurrent });
  try { assertCurrent(); } catch (error) { if (typeof approved === 'object') approved.close(); throw error; }
  // Canonical autonomous dispatch requires a live final-effect capability. A
  // wrapper must not downgrade that capability to a legacy truthy boolean.
  if (!approved || (currentExternalOperationSource() && approved === true)) return { deniedEscalations: decision.escalations };
  reportContainedRun();
  return typeof approved === 'object' ? { admission: approved } : null;
}

/**
 * Build the standing one-line context note for a run inside the boundary.
 *
 * The note exists because the boundary's world differs from the host's in ways
 * that look identical to fact when you only see the output: a fresh network
 * namespace whose `127.0.0.1` is its own, not the host's; a read-only
 * filesystem outside the workspace; a masked /tmp and $HOME; and narrower
 * device and process visibility. A probe that found no Bluetooth adapter and no
 * daemon on `127.0.0.1:3421` was read as the user's machine lacking both.
 *
 * Naming the isolation is only half of it. A model told the daemon is
 * unreachable and nothing else will keep reaching for it, a second curl, then
 * systemctl, then a port check, because the note ruled out the route it had
 * without naming another. So the note names the tools that DO answer the
 * question from outside the boundary, `goodvibes_context` and
 * `goodvibes_settings`, which is what turns a dead end into a next step.
 *
 * It names the isolation, the way through it, and the one action that changes
 * it, and stops. It is not a lecture and it is not repeated per line, one
 * field, once per result.
 */
export function buildSandboxNote(plan: ExecSandboxPlan): string {
  if (!plan.sandboxed) {
    return `not sandboxed: ${plan.unavailableReason ?? 'no boundary applied'}, this ran directly on the host.`;
  }
  const parts: string[] = ['sandboxed: this ran inside a boundary, not on the host'];
  if (plan.network === 'enabled') {
    parts.push('host network shared (localhost services reachable)');
  } else if (plan.network === 'unknown') {
    parts.push(
      'network isolation requested but unconfirmed on this host, so localhost reachability here is not something to reason from',
    );
  } else {
    parts.push(
      `separate network namespace, so host localhost services are unreachable from here, the goodvibes daemon on 127.0.0.1:${plan.daemonPort ?? DEFAULT_CONTROL_PLANE_PORT} refuses connections inside the boundary even while it is running on the host, so read daemon and settings state with the built-in goodvibes_context tool (mode "summary" for runtime and daemon state, "config_get" for a setting) and change settings with the built-in goodvibes_settings tool, both of which run outside this boundary, rather than retrying curl or systemctl in here (a command that needs the host network has to be on sandbox.egressAllowlist, and widening that list is the owner's decision, so tell the owner which command needs it)`,
    );
  }
  parts.push(
    `filesystem read-only outside the workspace, /tmp isolated${plan.homeMasked ? ' and $HOME masked' : ''}, credential-bearing environment variables removed, and partial device and process visibility`,
  );
  parts.push(
    'absence observed here is not absence on the host, re-check on the host before concluding something is missing',
  );
  if (plan.ignoredSettings?.length) parts.push(`settings file entries not applied: ${plan.ignoredSettings.join('; ')}`);
  return `${parts.join('; ')}.`;
}

/**
 * Attach sandbox metadata to an exec result. Stays quiet (returns the result
 * unchanged) when there is no plan, or when the sandbox is off entirely and the
 * command simply ran unsandboxed, metadata appears only when the sandbox was
 * active OR was requested-but-unavailable (the honest-unavailable receipt).
 */
export function attachSandboxMeta(result: ExecCommandResult, plan: ExecSandboxPlan | null): ExecCommandResult {
  if (!plan) return result;
  if (!plan.sandboxed && !plan.unavailableReason) return result;
  return {
    ...result,
    sandboxed: plan.sandboxed,
    sandbox_boundary: plan.boundary,
    sandbox_note: buildSandboxNote(plan),
    ...(plan.sandboxed ? { sandbox_network: plan.network } : {}),
    ...(plan.escalationsGranted.length > 0 ? { sandbox_escalations: plan.escalationsGranted } : {}),
  };
}

let hostAvailability: SandboxAvailability | undefined;

/**
 * The host's sandbox availability, probed once per process. The exec tool at
 * registration and the approval gates that auto-allow a contained command read
 * this one value, so a gate can never call a command contained while the exec
 * tool runs it on the host. Installing bubblewrap or enabling user namespaces
 * takes effect on the next start.
 */
export function hostSandboxAvailability(): SandboxAvailability {
  hostAvailability ??= detectSandboxAvailability(probeSandboxHost());
  return hostAvailability;
}

/**
 * Probe the real host for bubblewrap availability. Impure (spawns `bwrap`
 * trivially, bounded to a short timeout); the pure {@link detectSandboxAvailability}
 * turns the result into an {@link SandboxAvailability}. Non-Linux short-circuits
 * without spawning. This is the wiring production uses; unit tests exercise
 * detection with fabricated probes instead of spawning.
 */
export function probeSandboxHost(env: NodeJS.ProcessEnv = process.env): SandboxHostProbe {
  const platform = process.platform;
  if (platform !== 'linux') {
    return { platform, bwrapPath: null, bwrapWorks: false, netUnshareWorks: false };
  }
  const resolved = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8', timeout: 5000, env });
  const bwrapPath = resolved.status === 0 ? resolved.stdout.trim() || null : null;
  if (!bwrapPath) {
    return { platform, bwrapPath: null, bwrapWorks: false, netUnshareWorks: false };
  }
  // Probe with the argv a real run uses, so a host where its namespaces, tmpfs or
  // binds fail is reported unavailable instead of failing every command later.
  let workspace: string;
  try {
    workspace = mkdtempSync(join(tmpdir(), 'gv-bwrap-probe-'));
  } catch {
    // No usable temp directory means the probe cannot run; report unavailable rather than throw at startup.
    return { platform, bwrapPath, bwrapWorks: false, netUnshareWorks: false };
  }
  let bwrapWorks = false;
  let netUnshareWorks = false;
  try {
    const attempt = (networkEnabled: boolean): boolean => {
      const [command, ...args] = buildBwrapArgv({ bwrapPath, workspaceDir: workspace, cwd: workspace, writableExtras: [], networkEnabled });
      return spawnSync(command!, [...args, '/bin/true'], { timeout: 5000, env }).status === 0;
    };
    bwrapWorks = attempt(true);
    netUnshareWorks = attempt(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  return { platform, bwrapPath, bwrapWorks, netUnshareWorks };
}
