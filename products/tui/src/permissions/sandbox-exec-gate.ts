/**
 * sandbox-exec-gate.ts, sandbox-aware layer over the exec approval ask.
 *
 * The per-command exec sandbox already RUNS boundary-safe commands inside a
 * bubblewrap boundary (the platform exec tool's runner half). This is the APPROVAL
 * half: when the base permission policy would prompt ("ask") for an exec, and
 * the sandbox is genuinely active, a command that runs entirely inside the OS
 * boundary with no host-access need should auto-allow instead of prompting,
 * and a command that still needs host access should surface as an explicit ask
 * that NAMES what it wants ("wants network …", "wants host privilege
 * escalation").
 *
 * The decision is the platform's `decideSandboxedExec`, never re-implemented here.
 * This module only (a) reads the sandbox posture the exec tool was registered with, (b) extracts the exec
 * command(s) from the request, (c) maps the platform decision onto the existing ask
 * callback: allow → approve without prompting; ask → attach the named
 * escalations to the request so the approval card renders them, then delegate to
 * the underlying ask. Non-exec requests, and any request while the sandbox is
 * inactive, pass through byte-for-byte unchanged.
 *
 * The network a command on the owner's egress allowlist needs is not asked here:
 * the exec runner asks it once, inside the call that runs the command, with the
 * exact boundary plan (`askedAtRun` on the platform decision). So the owner is
 * never asked the same question twice for one command, and no answer given here
 * outlives the call it was given for.
 *
 * This runs INSIDE the permission machinery's ask layer (like trustGatedAsk), so
 * it composes with the real layer chain and is only ever consulted for execs the
 * base policy already resolved to "ask", it can never turn a deny into an allow,
 * and the frozen catastrophic block is untouched. It settles only an ask the gate
 * marked `containable` (asked only for where the call could reach); an ask the
 * gate routed to the owner (an owner-only item, an irreversible or
 * security-loosening call) always reaches him. An approval made here carries
 * `settledBy: 'sandbox'`, so it is recorded as this layer's, never as the owner's.
 */
import { decideSandboxedExec, readCommandNeeds, type SandboxPolicyDecision } from '@goodvibes-jev/engine/platform/platform/runtime/permissions/sandbox-policy';
import { execCommandText, hostSandboxAvailability, type SandboxAvailability } from '@goodvibes-jev/engine/platform/platform/tools/exec/sandbox';
import type { ApprovalRaise } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { JudgmentAuthorityRetiredError, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import type {
  PermissionPromptRequest,
  PermissionRequestHandler,
} from '@goodvibes-jev/engine/platform/platform/permissions';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { readSandboxExecList, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY } from '../input/sandbox-exec-config.ts';

/**
 * TUI-local metadata the gate attaches to an exec ask so the approval card can
 * render the sandbox posture and the named escalations. Carried as extra own
 * properties on the request object (they survive the broker → local-prompt
 * spread); the renderer reads them defensively.
 */
export interface SandboxAskAnnotation {
  /** True when the command(s) will run inside the boundary. */
  readonly sandboxed: boolean;
  /** Named host-access needs to show as the ask's escalations (from the platform policy). */
  readonly sandboxEscalations: readonly string[];
}

export interface SandboxExecAskDeps {
  /** The graduation-gated `exec-sandbox` feature flag state. */
  readonly isSandboxFeatureEnabled: () => boolean;
  /** The `sandbox.enabled` config switch. */
  readonly isSandboxConfigEnabled: () => boolean;
  /** The `sandbox.egressAllowlist` command base names. */
  readonly readEgressAllowlist: () => readonly string[];
  /**
   * Host availability of the exec sandbox backend: the one reading the exec tool
   * was registered with (`hostSandboxAvailability`, probed once per process), so
   * the gate never calls a command contained that the tool runs on the host.
   */
  readonly availability: () => SandboxAvailability;
}

/**
 * Build the gate's dependencies from the runtime's config + feature flags.
 * The exec tool decides at registration whether to wire a sandbox at all (feature
 * flag and `sandbox.enabled` both on), then reads `sandbox.enabled` and the egress
 * allowlist live for every command. The gate prices an ask against the same
 * posture: the startup decision is captured once (a sandbox switched on mid-session
 * was never wired, so it must not be trusted), while the config switch and the
 * allowlist are read live (a sandbox switched off mid-session runs unsandboxed, so
 * the ask must go to the owner). Call this where the tools are registered. The host
 * availability is the exec tool's own, taken when it was registered.
 */
export function sandboxExecAskDepsFromRuntime(
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'>,
): SandboxExecAskDeps {
  const featureEnabled = featureFlags.isEnabled('exec-sandbox');
  const wiredAtStartup = featureEnabled && Boolean(configManager.getCategory('sandbox').enabled);
  return {
    isSandboxFeatureEnabled: () => featureEnabled,
    isSandboxConfigEnabled: () => wiredAtStartup && Boolean(configManager.getCategory('sandbox').enabled),
    readEgressAllowlist: () => readSandboxExecList(configManager, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY),
    availability: hostSandboxAvailability,
  };
}

/**
 * Pull the shell command text(s) out of an exec request's args, read the way the
 * exec tool reads them (`execCommandText`: a `cmd_base64` entry is judged by the
 * text it decodes to). An entry the tool would refuse (invalid base64, or `cmd`
 * and `cmd_base64` that disagree) is left out here and `execArgsNeedOwner` sends
 * the request to the owner.
 */
export function extractExecCommands(request: PermissionPromptRequest): string[] {
  const args = request.args ?? {};
  const out: string[] = [];
  if (Array.isArray(args.commands)) {
    for (const entry of args.commands) {
      const text = entryText(entry);
      if (text !== null) out.push(text);
    }
  }
  if (typeof args.command === 'string') out.push(args.command);
  if (typeof args.cmd === 'string') out.push(args.cmd);
  return out.filter((c) => c.length > 0);
}

function entryText(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const cmd = optionalText(record.cmd);
  const encoded = optionalText(record.cmd_base64);
  if (cmd === null || encoded === null) return null;
  try {
    const text = execCommandText({ cmd, cmd_base64: encoded });
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** A string field, undefined when absent, null when it holds something other than text. */
function optionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * True when the request carries something the gate's command reading does not
 * cover, so the owner must be asked rather than the sandbox decision trusted:
 * host-side `file_ops` (they run on the host before any command, outside the
 * boundary), a command entry the exec tool would refuse to read, or a working
 * directory other than the one the commands were judged against.
 */
export function execArgsNeedOwner(request: PermissionPromptRequest): boolean {
  const args = request.args ?? {};
  if (Array.isArray(args.file_ops) ? args.file_ops.length > 0 : args.file_ops !== undefined && args.file_ops !== null) return true;
  const judgedDirectory = request.workingDirectory;
  const differs = (value: unknown): boolean => {
    const directory = nonEmptyString(value);
    return directory !== undefined && directory !== judgedDirectory;
  };
  if (differs(args.working_dir)) return true;
  if (Array.isArray(args.commands)) {
    for (const entry of args.commands) {
      if (entryText(entry) === null) return true;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        if (differs(record.cwd) || differs(record.working_dir)) return true;
      }
    }
  }
  return false;
}

/** True for the shell-command tool whose asks the sandbox policy can relax. */
function isExecRequest(request: PermissionPromptRequest): boolean {
  return request.category === 'execute' && request.tool === 'exec';
}

/**
 * Wrap the permission machinery's ask callback with the sandbox-aware exec
 * policy. Only exec asks the gate marked `containable` are considered;
 * everything else delegates unchanged.
 */
export function createSandboxExecAsk(deps: SandboxExecAskDeps, ask: PermissionRequestHandler): PermissionRequestHandler {
  return async (request, options) => {
    // The offer is for this layer only; the owner's prompt and the daemon never see it.
    const toOwner = withoutOffer(request);
    // Only an ask the gate offered as containable is this layer's to settle: one the gate routed
    // to the owner (an owner-only item, an irreversible or security-loosening call) is his alone.
    if (request.containable !== true || request.ownerOnly !== undefined) return ask(toOwner, options);
    // Without a decision model, this keeps actual OS containment but asks the owner instead of semantically inferring host-access needs.
    if (decisionModelPolicyState().operation === 'no-decision-model') return ask(toOwner, options);
    if (!isExecRequest(request)) return ask(toOwner, options);
    // The exec runner's own escalation ask comes back through the same raiser; it is the
    // one place that question is put to the owner, so it is never relaxed here.
    if (request.attribution?.kind === 'sandbox-escalation') return ask(toOwner, options);
    const commands = extractExecCommands(request);
    if (commands.length === 0 || execArgsNeedOwner(request)) return ask(toOwner, options);

    // The sandbox is genuinely active only when the feature flag AND the config
    // switch are on AND the host can actually provide a boundary.
    const featureAndConfig = deps.isSandboxFeatureEnabled() && deps.isSandboxConfigEnabled();
    const sandboxActive = featureAndConfig && deps.availability().available;
    if (!sandboxActive) return ask(toOwner, options);

    const egressAllowlist = [...deps.readEgressAllowlist()];
    const workspace = request.workingDirectory;
    const assertCurrent = () => {
      const currentCommands = extractExecCommands(request);
      const currentEgress = deps.readEgressAllowlist();
      if (options?.signal?.aborted || !isExecRequest(request) || request.workingDirectory !== workspace
        || execArgsNeedOwner(request)
        || currentCommands.length !== commands.length || currentCommands.some((command, index) => command !== commands[index])
        || !deps.isSandboxFeatureEnabled() || !deps.isSandboxConfigEnabled()
        || currentEgress.length !== egressAllowlist.length || currentEgress.some((command, index) => command !== egressAllowlist[index])) {
        throw new JudgmentAuthorityRetiredError();
      }
    };
    const decisions = await Promise.all(commands.map(async (command) =>
      decideSandboxedExec({ command, needs: await readCommandNeeds(command, workspace, { signal: options?.signal, assertCurrent }), sandboxActive: true, egressAllowlist, baseEffectWhenNotSandboxed: 'ask' }),
    ));
    assertCurrent();

    // A batch auto-allows only when no command leaves a question for this card:
    // each is boundary-safe, or its one escalation is the allowlisted network the
    // runner asks inside its own call. Otherwise the whole ask surfaces with the
    // union of the escalations this card decides.
    // Recorded by the gate as this layer's decision, never as the owner's answer.
    if (!decisions.some(asksHere)) return { approved: true, settledBy: 'sandbox' };
    const escalations = dedupe(decisions.flatMap(escalationsAskedHere));
    return ask(annotateExecAsk(toOwner, { sandboxed: true, sandboxEscalations: escalations }), options);
  };
}

/** The escalations of one decision that this gate puts to the owner (not the runner's own ask). */
function escalationsAskedHere(decision: SandboxPolicyDecision): string[] {
  return decision.escalations.filter((escalation) => escalation !== decision.askedAtRun);
}

/** True when a decision needs the owner at this gate: an unassessed ask, or an escalation the runner does not ask. */
function asksHere(decision: SandboxPolicyDecision): boolean {
  return decision.effect === 'ask' && (decision.escalations.length === 0 || escalationsAskedHere(decision).length > 0);
}

/**
 * The same sandbox-aware exec policy in front of an approval raiser, for the
 * asks a worker raises (it has no permission manager of its own). The gate is
 * built per ask so the caller's signal and routing travel with it.
 */
export function sandboxAwareApprovalRaiser(deps: SandboxExecAskDeps, raise: ApprovalRaise): ApprovalRaise {
  return ({ request, ...extras }) =>
    createSandboxExecAsk(deps, (annotated, execution) =>
      raise({ ...extras, request: annotated, ...(execution?.signal ? { signal: execution.signal } : {}) }),
    )(request, extras.signal ? { signal: extras.signal } : undefined);
}

/** The request as the owner is asked it: the containment offer stays with this layer. */
function withoutOffer(request: PermissionPromptRequest): PermissionPromptRequest {
  if (request.containable === undefined) return request;
  const { containable: _offer, ...rest } = request;
  return rest;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Attach the sandbox annotation to a copy of the request (never mutate the original). */
function annotateExecAsk(
  request: PermissionPromptRequest,
  annotation: SandboxAskAnnotation,
): PermissionPromptRequest {
  return Object.assign({}, request, annotation);
}

/** Read the sandbox annotation off a request, if the gate attached one. */
export function readSandboxAskAnnotation(request: unknown): SandboxAskAnnotation | null {
  if (!request || typeof request !== 'object') return null;
  const candidate = request as Partial<SandboxAskAnnotation>;
  if (candidate.sandboxed !== true || !Array.isArray(candidate.sandboxEscalations)) return null;
  return { sandboxed: true, sandboxEscalations: candidate.sandboxEscalations };
}
