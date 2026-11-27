/**
 * capability-cli-confirm.ts, which `do` a command line sends without a person's claim (capability-cli.ts): one that
 * weakens a protection (installs something that runs by itself included), cannot be undone, spends money, writes a
 * secret or is the owner's own act (platform capabilities/command-line-hold.ts, the rule the daemon applies too). Such
 * a call is held for the owner and answered in Waiting for you (a terminal program, the web UI, a paired phone),
 * opening on No. Nothing is asked at the terminal: a y there can be typed by anything that can drive a terminal.
 * Every other capability runs at once.
 */

/**
 * Why this call is held for the owner, or undefined when it runs at once. Read from this program's own capability
 * definitions (the daemon's are the same build); a capability this program does not know is held, since what it does
 * cannot be said here.
 */
export async function heldForOwnerReason(id: string, inputs: Readonly<Record<string, string>>): Promise<string | undefined> {
  const capabilities = await import('@goodvibes/engine/platform/platform/capabilities');
  const entry = capabilities.movedCapabilityEntries().find((candidate) => candidate.id === id);
  if (!entry) return 'this program does not know that capability, so what it does cannot be said here';
  const definition = capabilities.daemonCapability(id) ?? capabilities.methodCapability(id);
  const steers = capabilities.daemonCapability(id)?.steersModel === true;
  return capabilities.commandLineHoldReason(entry, inputs, definition?.loosensIf, steers);
}
