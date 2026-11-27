/**
 * no-sandbox-notice.ts, the one line the terminal app and the Agent say at start when a model's commands have no
 * working sandbox around them: what such a command can then reach, and the control that turns the sandbox on. The
 * permission gate decides what the model may ASK GoodVibes to do; only the sandbox limits what a command it is allowed
 * to run can reach (docs/llms/40-permissions-and-decisions.md, "The exec sandbox"). Said once per start, never again.
 */

/** What a command the model may run reaches with no sandbox, in the line's words. */
const REACH = 'a command the model is allowed to run can read and change whatever your account can (your files, your keys, GoodVibes\' own settings and token) and use the network';

/** The line, or undefined when commands run inside a working sandbox. `sandboxSetting`: `sandbox.enabled` as set. */
export async function noSandboxStartupLine(sandboxSetting: unknown): Promise<string | undefined> {
  if (sandboxSetting !== true) {
    return `[Security] Commands run without a sandbox: ${REACH}. Turn the sandbox on in Permissions and safety, Sandbox setting, Commands ("run them inside the sandbox").`;
  }
  // The host is probed only when the sandbox is on (the exec tool reads the same one value).
  const { hostSandboxAvailability } = await import('@goodvibes/engine/platform/platform/tools/exec/sandbox');
  const availability = hostSandboxAvailability();
  if (availability.available) return undefined;
  return `[Security] The sandbox is on but this machine cannot give one (${availability.reason}), so commands run without it: ${REACH}. Install bubblewrap (bwrap) and start again.`;
}
