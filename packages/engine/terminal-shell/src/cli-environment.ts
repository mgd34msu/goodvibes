import { accessSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
export function openBrowser(
  url: string,
  seams: { readonly platform?: NodeJS.Platform | undefined; readonly spawn?: typeof spawn | undefined; readonly allowFile?: boolean | undefined } = {},
): string {
  // Only a web address is handed to the system opener; anything else (a file path, a custom scheme) would run a handler the person did not ask for.
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'browser open refused: not a valid web address; copy it into a browser yourself';
  }
  // A caller that wrote the file itself (an export it just made) may open it; a web address from elsewhere never gets that.
  if (protocol !== 'http:' && protocol !== 'https:' && !(seams.allowFile && protocol === 'file:')) return `browser open refused: only http and https addresses are opened, not ${protocol}; copy it into a browser yourself if you trust it`;
  const platform = seams.platform ?? process.platform;
  // cmd treats & in an OAuth URL as a command separator, so Windows goes through the URL handler directly instead.
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = (seams.spawn ?? spawn)(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return 'browser open requested';
  } catch (error) {
    return `browser open failed: ${summarizeError(error)}`;
  }
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
