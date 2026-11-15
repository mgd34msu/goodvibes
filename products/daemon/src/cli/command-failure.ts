/** Fixed reason and next step for the installation guards that service activation can hit. */
const installationGuards = new Map<string, string>([
  ['Running daemon does not own the installed native version', 'INSTALLATION_NOT_OWNED'],
  ['Running daemon image differs from the installed executable', 'INSTALLATION_NOT_OWNED'],
  ['Native daemon installation has an unfinished transaction', 'INSTALLATION_UNSETTLED'],
  ['Native service executable path is unavailable', 'INSTALLATION_UNAVAILABLE'],
  ['Native service executable admission is unavailable', 'INSTALLATION_UNAVAILABLE'],
  ['Original compiled Darwin daemon selection is unavailable', 'INSTALLATION_NOT_OWNED'],
  ['Running Darwin daemon does not own a complete verified installation', 'INSTALLATION_NOT_OWNED'],
  ['Darwin daemon reader profile differs from its actual compiled readers', 'INSTALLATION_UNAVAILABLE'],
  ['Darwin daemon installation has an unfinished transaction', 'INSTALLATION_UNSETTLED'],
]);
const nextSteps: Record<string, string> = {
  INSTALLATION_NOT_OWNED: 'This binary is not the installed daemon. Run the command from the installed goodvibes-daemon, or reinstall the suite with the released installer.',
  INSTALLATION_UNSETTLED: 'An update is unfinished. Wait for it to finish or rerun the installer, then retry.',
  INSTALLATION_UNAVAILABLE: 'The installed daemon could not be identified. Reinstall the suite with the released installer.',
};

/**
 * Lines printed when a command throws. Only a fixed set of guard messages gets a
 * reason; any other exception text may carry config values and is never printed.
 */
export function daemonCommandFailureLines(error: unknown): readonly string[] {
  let message: unknown;
  try {
    const descriptor = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message') : undefined;
    message = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { /* A borrowed accessor or proxy never grants a diagnostic value. */ }
  const code = typeof message === 'string' ? installationGuards.get(message) : undefined;
  return code === undefined ? ['Daemon command failed'] : ['Daemon command failed', `Reason: ${code}. ${nextSteps[code]}`];
}
