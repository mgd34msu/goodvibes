import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readTuiLegacyPairingBootstrap } from '../src/runtime/tui-host-pairing-bootstrap.ts';
import { DAEMON_SERVICE_NAME } from '@goodvibes/engine/platform/platform/daemon/daemon-service-default';

/** Read GOODVIBES_DAEMON_TOKEN from `<dataDir>/environment` (matching scripts/install.ts), if present. */
function readEnvironmentDaemonToken(dataDir: string): string | undefined {
  const envFile = join(dataDir, 'environment');
  if (!existsSync(envFile)) return undefined;
  try {
    for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^GOODVIBES_DAEMON_TOKEN=(.*)$/.exec(line);
      if (!match) continue;
      const raw = match[1]!.trim();
      const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\'')) ? raw.slice(1, -1) : raw;
      if (value) return value;
    }
  } catch { /* unreadable environment file falls back to process.env / token file */ }
  return undefined;
}

// The installer's last step for a daemon it installed as a service: it names the installer's `--workspace` to the
// daemon as a project, and reads that the daemon is ready for work. Nothing is paired: the installed terminal app
// and Agent connect with the machine's own token (the daemon's operator token in the installation's data folder),
// and so does this script.
const [prefixArg, homeArg, portArg, workspaceArg, unitArg] = process.argv.slice(2);
if (!prefixArg || !homeArg || !portArg || !workspaceArg) throw new Error('Expected installation prefix, data directory, port and workspace.');
const prefix = resolve(prefixArg), home = resolve(homeArg), port = Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid installed daemon port.');
const unit = unitArg ?? `${DAEMON_SERVICE_NAME}.service`;
const pid = execFileSync('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
if (!/^[1-9][0-9]*$/.test(pid)) throw new Error(`Installed daemon service ${unit} is not running (MainPID=${pid || '0'}).`);
const executable = realpathSync(join(prefix, 'current', 'daemon', `goodvibes-daemon-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`));
if (readlinkSync(`/proc/${pid}/exe`) !== executable) throw new Error('The workspace is registered only with the daemon running from this installation.');
const host = `http://127.0.0.1:${port}`;
const workspaceRoot = realpathSync(workspaceArg);
async function invoke(token: string, method: string, body: object = {}, project?: string): Promise<void> {
  const response = await fetch(`${host}/api/control-plane/methods/${method}/invoke`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(project ? { 'x-goodvibes-project': encodeURIComponent(project) } : {}),
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Installed daemon ${method} failed: HTTP ${response.status}.`);
}
const token = readEnvironmentDaemonToken(home) ?? process.env['GOODVIBES_DAEMON_TOKEN']?.trim() ?? readTuiLegacyPairingBootstrap(home);
if (!token) throw new Error('Installed daemon token is unavailable: its file must be your own private file.');
await invoke(token, 'workspaces.registrations.add', { root: workspaceRoot, origin: 'installer', label: 'Installed daemon workspace' });
await invoke(token, 'workLedger.intake.get', { inputId: 'installation-readiness-check' }, workspaceRoot);
console.log('Installed daemon workspace registered and daemon ready for work.');
