import { accessSync, constants } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
export function getLocalNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] ?? []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}
export function openBrowser(
  url: string,
  seams: { readonly platform?: NodeJS.Platform | undefined; readonly spawn?: typeof spawn | undefined; readonly allowFile?: boolean | undefined } = {},
): string {
  // Only a web address is handed to the system opener; anything else (a file path, a custom scheme) would run a handler the person did not ask for.
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'browser open refused: not a valid address';
  }
  // A caller that wrote the file itself (an export it just made) may open it; a web address from elsewhere never gets that.
  if (protocol !== 'http:' && protocol !== 'https:' && !(seams.allowFile && protocol === 'file:')) return `browser open refused: ${protocol} addresses are not opened`;
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
