/** platform-owned platform module. This implementation is maintained in goodvibes-platform. */

import { spawn } from 'node:child_process';
import { summarizeError } from './error-display.js';
import { logger } from './logger.js';

const OPEN_EXTERNAL_TIMEOUT_MS = 5000;

function trimOutput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function spawnLauncher(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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

    const finish = (ok: boolean, detail?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!ok) {
        logger.warn('External URL launcher failed', {
          command,
          argCount: args.length,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          ...detail,
        });
      }
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(false, { error: `timed out after ${OPEN_EXTERNAL_TIMEOUT_MS}ms` });
    }, OPEN_EXTERNAL_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.once('error', (error) => {
      finish(false, { error: summarizeError(error) });
    });
    child.once('close', (code, signal) => {
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
