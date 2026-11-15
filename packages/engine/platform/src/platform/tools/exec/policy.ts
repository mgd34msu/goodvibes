/**
 * policy.ts, the per-composition postures every command in an exec call is
 * judged against, and the refusals they produce.
 *
 * Three things a composition may state about its exec tool: the boundary wiring
 * (sandbox.ts), the PTY wiring (interactive.ts) and whether the boundary is
 * REQUIRED (containment.ts). The owner's terminal is covered by that boundary and
 * by the owner's tool permissions, not by a command check. They travel together
 * as one object rather than
 * three positional parameters, so the chain from `executeResolvedCommands` down
 * to `runCommand` threads one argument and a future posture is added here
 * rather than in five signatures.
 *
 * The refusal builders live here too, beside the postures they belong to, so
 * the runtime reads as "ask, and return the answer if there is one" rather than
 * carrying three refusal texts inline.
 */

import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { CapturedExecAuthority } from './captured-exec.js';
import type { ExecCommandResult } from './schema.js';
import { decideExecContainment, type ExecContainmentRequirement } from './containment.js';
import type { ExecSandboxPlan, ExecSandboxRuntime } from './sandbox.js';
import type { ExecInteractionRuntime } from './interactive.js';

/** What a composition stated about its exec tool. */
export interface ExecRunPolicy {
  /** Exact invocation proof, sampled at final effects, never model input. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Called as command output arrives, so a long command that is printing is not mistaken for a silent one. */
  readonly onProgress?: (() => void) | undefined;
  /** Restriction-only guard retained alongside a captured background owner. */
  readonly assertWorkspaceCurrent?: (() => void) | undefined;
  readonly capturedInput?: CapturedExecAuthority | undefined;
  readonly sandbox: ExecSandboxRuntime | null;
  readonly interaction: ExecInteractionRuntime | null;
  readonly containment: ExecContainmentRequirement | null;
  /**
   * The session's project root. A sandboxed command's writable workspace is the
   * command's working directory, so a working_dir outside this root would hand
   * the boundary the rest of the host; it is refused instead. Absent: no check.
   */
  readonly workspaceRoot?: string | undefined;
}

/** A command that will not run, shaped like every other refusal this tool returns. */
export function refusedResult(cmdStr: string, reason: string): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: reason, success: false, denied: true };
}

/**
 * The containment verdict for one command, or null when it may run. Consulted
 * after the sandbox plan resolves, because the answer depends on whether a
 * boundary was actually applied.
 */
export function containmentRefusal(
  policy: ExecRunPolicy,
  cmdStr: string,
  plan: ExecSandboxPlan | null,
): ExecCommandResult | null {
  const decision = decideExecContainment(policy.containment, plan);
  if (decision.allowed) return null;
  return refusedResult(cmdStr, decision.refusal ?? 'Command refused: the exec boundary is required here.');
}

const realOrResolved = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

/**
 * Refuses a sandboxed command whose working_dir lies outside the session's
 * project root, or null when it may run. The boundary binds the working
 * directory read-write, last, over the read-only system and the masked $HOME,
 * so `working_dir: "/"` would turn the boundary into the whole host.
 */
export function sandboxWorkspaceRefusal(
  policy: ExecRunPolicy,
  cmdStr: string,
  plan: ExecSandboxPlan | null,
  workingDirectory: string,
): ExecCommandResult | null {
  if (!plan?.sandboxed || !policy.workspaceRoot) return null;
  const root = realOrResolved(policy.workspaceRoot);
  const rel = relative(root, realOrResolved(workingDirectory));
  if (rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..') && !rel.startsWith(sep))) return null;
  return refusedResult(
    cmdStr,
    `Command refused: working_dir '${workingDirectory}' is outside this session's project root '${policy.workspaceRoot}', `
    + 'and a sandboxed command can write wherever its working directory is. '
    + 'Use a working_dir inside the project root.',
  );
}

/**
 * Whether a BACKGROUND command may run under this policy.
 *
 * A detached command cannot be contained at all: a bwrap boundary is
 * `--die-with-parent`, so wrapping one would kill the process the caller asked
 * to detach. A composition that requires containment therefore has no contained
 * background path, and the command is refused rather than quietly granted the
 * exemption the detach needs, `background: true` must not be the spelling that
 * gets a contained turn onto the host.
 */
export function backgroundContainmentRefusal(policy: ExecRunPolicy, cmdStr: string): ExecCommandResult | null {
  if (policy.containment?.posture !== 'required') return null;
  return refusedResult(
    cmdStr,
    'Command refused: a background command cannot run inside the exec boundary '
    + '(the boundary dies with this tool call, which would defeat the detach), and this '
    + `session requires containment, ${policy.containment.reason}\n`
    + 'Run it in the foreground, or report what you would need instead.',
  );
}
