import { spawn } from 'node:child_process';
import { summarizeError } from './error-display.js';
import { logger } from './logger.js';

/**
 * How long a launcher is given to report failure. A launcher still running
 * then is holding the browser it started (xdg-open runs a browser in the
 * foreground when none was running), so the URL counts as opened.
 */
const OPEN_EXTERNAL_TIMEOUT_MS = 5000;

/**
 * Starts one launcher detached in its own session, with no pipes to this
 * process, so a browser it starts outlives it and never holds the terminal.
 * An 'error' event or a non-zero exit is this launcher failing; exit 0, or
 * still running when the window ends, is the URL opened.
 */
function spawnLauncher(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      logger.warn('External URL launcher failed', {
        command,
        argCount: args.length,
        error: summarizeError(error),
      });
      resolve(false);
      return;
    }
    child.unref();

    const finish = (ok: boolean, detail?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!ok) {
        logger.warn('External URL launcher failed', {
          command,
          argCount: args.length,
          ...detail,
        });
      }
      resolve(ok);
    };

    const deadline = setTimeout(() => finish(true), OPEN_EXTERNAL_TIMEOUT_MS);
    deadline.unref?.();

    child.once('error', (error) => {
      finish(false, { error: summarizeError(error) });
    });
    child.once('exit', (code, signal) => {
      finish(code === 0, { exitCode: code, signal });
    });
  });
}

/** One program and its arguments, tried in order until one reports success. */
export interface ExternalUrlLauncher {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The launchers for `url` on a platform, in the order they are tried.
 *
 * Windows opens the URL through `rundll32 url.dll,FileProtocolHandler`, which
 * receives it as one argument. `cmd.exe /c start` would hand it to the command
 * interpreter, where `&`, `|` and `^` in an authorize URL split the command and
 * can run whatever follows.
 */
export function externalUrlLaunchers(
  url: string,
  platform: NodeJS.Platform,
  underWsl: boolean,
): readonly ExternalUrlLauncher[] {
  const windows: ExternalUrlLauncher = { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return [{ command: 'open', args: [url] }];
  if (platform === 'win32') return [windows];
  if (underWsl) return [{ command: 'wslview', args: [url] }, windows, { command: 'xdg-open', args: [url] }];
  return [{ command: 'xdg-open', args: [url] }];
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Opens an http(s) URL in the default browser. Any other scheme, or a URL that does not parse, is refused (false) without launching anything. */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isWebUrl(url)) {
    logger.warn('External URL not opened because it is not an http(s) URL', { argCount: 1 });
    return false;
  }
  for (const launcher of externalUrlLaunchers(url, process.platform, Boolean(process.env['WSL_DISTRO_NAME']))) {
    if (await spawnLauncher(launcher.command, [...launcher.args])) return true;
  }
  return false;
}
