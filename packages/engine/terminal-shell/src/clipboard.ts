import { logger } from '@goodvibes/engine/platform/platform/utils';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { allowTerminalWrite } from './terminal-write.js';

/**
 * What a copy did: `copied` when a system clipboard program took the text and
 * said so (it exited 0), `sent` when it went to the terminal as OSC 52 (the
 * terminal gives no acknowledgement, so whether it landed is not known), and
 * `failed` when neither could be done.
 */
export type CopyOutcome = 'copied' | 'sent' | 'failed';

/** The words a copy is reported in: "Copied" only when a program confirmed it. */
export function copyOutcomeWords(outcome: CopyOutcome): string {
  if (outcome === 'copied') return 'Copied';
  if (outcome === 'sent') return 'Sent to your terminal\'s clipboard';
  return 'Not copied: nothing could reach a clipboard';
}

let lastOutcome: CopyOutcome = 'sent';

/** How the last copy went, for the status line's short receipt. */
export function lastCopyOutcome(): CopyOutcome {
  return lastOutcome;
}

/**
 * The system clipboard programs for this machine, in the order tried. None
 * over SSH: a program there fills the remote machine's clipboard, not the
 * one in front of the person, so the terminal (OSC 52) is the only way.
 */
function clipboardPrograms(): string[][] {
  const env = process.env;
  if (env['SSH_CONNECTION'] || env['SSH_TTY']) return [];
  if (process.platform === 'darwin') return [['pbcopy']];
  if (process.platform === 'win32') return [['clip.exe']];
  const programs: string[][] = [];
  if (env['WAYLAND_DISPLAY']) programs.push(['wl-copy']);
  if (env['DISPLAY']) programs.push(['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']);
  // Windows Subsystem for Linux: the Windows clipboard.
  if (env['WSL_DISTRO_NAME']) programs.push(['clip.exe']);
  return programs;
}

function copyWithProgram(text: string): boolean {
  for (const command of clipboardPrograms()) {
    try {
      if (Bun.which(command[0]!) === null) continue;
      const result = Bun.spawnSync(command, { stdin: Buffer.from(text), stdout: 'ignore', stderr: 'pipe' });
      if (result.exitCode === 0) {
        logger.info('Clipboard: copied with a system clipboard program', { program: command[0], length: text.length });
        return true;
      }
      logger.debug('Clipboard: a clipboard program refused the copy', { program: command[0], exitCode: result.exitCode });
    } catch (err: unknown) {
      logger.debug('Clipboard: a clipboard program could not start', { program: command[0], error: summarizeError(err) });
    }
  }
  return false;
}

/**
 * Copy text: a system clipboard program when one is present (wl-copy, xclip,
 * xsel, pbcopy, clip.exe), else the OSC 52 sequence to the terminal.
 */
export function copyToClipboard(text: string): CopyOutcome {
  if (!text) return 'failed';
  if (copyWithProgram(text)) {
    lastOutcome = 'copied';
    return lastOutcome;
  }
  try {
    const base64 = Buffer.from(text).toString('base64');
    const sequence = `\x1b]52;c;${base64}\x07`;
    allowTerminalWrite(() => process.stdout.write(sequence));
    logger.info('Clipboard: OSC 52 sequence written', { length: text.length });
    lastOutcome = 'sent';
  } catch (err: unknown) {
    logger.error('Clipboard: OSC 52 copy failed', { error: summarizeError(err) });
    lastOutcome = 'failed';
  }
  return lastOutcome;
}

export { pasteFromClipboard, pasteImageFromClipboard } from '@goodvibes/engine/platform/platform/utils';

export { missingClipboardReaderHint } from '@goodvibes/engine/platform/platform/utils';
