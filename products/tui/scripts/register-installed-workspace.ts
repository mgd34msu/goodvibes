import { readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readTuiLegacyPairingBootstrap } from '../src/runtime/tui-host-pairing-bootstrap.ts';
import { DAEMON_SERVICE_NAME } from '@goodvibes/engine/platform/platform/daemon/daemon-service-default';

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
const executable = realpathSync(join(prefix, 'current', 'daemon', `goodvibes-daemon-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`));
if (readlinkSync(`/proc/${pid}/exe`) !== executable) throw new Error('The workspace is registered only with the daemon running from this installation.');
const host = `http://127.0.0.1:${port}`;
async function invoke(token: string, method: string, body: object = {}): Promise<void> {
  const response = await fetch(`${host}/api/control-plane/methods/${method}/invoke`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Installed daemon ${method} failed: HTTP ${response.status}.`);
}
const token = readTuiLegacyPairingBootstrap(home);
if (!token) throw new Error('Installed daemon token is unavailable: its file must be your own private file.');
await invoke(token, 'workspaces.registrations.add', { root: realpathSync(workspaceArg), origin: 'installer', label: 'Installed daemon workspace' });
await invoke(token, 'workLedger.intake.get', { inputId: 'installation-readiness-check' });
console.log('Installed daemon workspace registered and daemon ready for work.');
