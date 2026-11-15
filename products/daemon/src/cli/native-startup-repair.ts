/**
 * The line printed when native startup cannot verify its installation. The
 * published-release acceptance script and the macOS diagnostic recognise it by
 * exact text, so this is the one place the sentence is written.
 */
export const NATIVE_STARTUP_REPAIR_MESSAGE = 'Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.';
