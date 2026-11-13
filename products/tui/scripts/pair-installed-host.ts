import { randomUUID } from 'node:crypto';
import { readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beginTuiHostPairing, completeTuiHostPairing, readTuiHostPairing, tuiHostPairingStorePath, type TuiHostPairingSecret } from '../src/runtime/tui-host-credential-store.ts';
import { readTuiLegacyPairingBootstrap } from '../src/runtime/tui-host-pairing-bootstrap.ts';

// The explicitly invoked local installer provisions its own client and daemon.
// Generic host pairing still requires the owner-terminal confirmation flow.
const [prefixArg, homeArg, portArg, workspaceArg] = process.argv.slice(2);
if (!prefixArg || !homeArg || !portArg || !workspaceArg) throw new Error('Expected installation prefix, data directory, port and workspace.');
const prefix = resolve(prefixArg), home = resolve(homeArg), port = Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid installed daemon port.');
const pid = execFileSync('systemctl', ['--user', 'show', 'goodvibes-jev.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
const executable = realpathSync(join(prefix, 'current', 'daemon', `goodvibes-daemon-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`));
if (readlinkSync(`/proc/${pid}/exe`) !== executable) throw new Error('Pairing requires the daemon running from this installation.');
const host = `http://127.0.0.1:${port}`;
/** Exit status the installer recognizes as "pairing skipped, installation otherwise complete". Keep in sync with scripts/install.ts. */
const PAIRING_DEFERRED_EXIT = 75;
/**
 * A pairing attempt is recorded BEFORE the daemon is asked to mint a token, and the store deliberately has
 * no reset: an abandoned attempt may already have minted one. So this never clears the record itself. It
 * reports what happened and exactly what the owner must do, then exits with the deferred status.
 */
function defer(what: string): never {
  const store = tuiHostPairingStorePath(home);
  console.error([
    `TUI pairing was NOT completed: ${what}`,
    `  Nothing was reset, reminted or revoked. The daemon at ${host} is installed and running.`,
    '  An abandoned attempt may already have minted a device token named "GoodVibes installed TUI".',
    '  To clear it and pair later:',
    '    1. In the terminal app run /devices, and revoke any "GoodVibes installed TUI" token: /devices revoke <id>',
    `    2. Remove the record for ${host} from ${store}`,
    '       (if that is the only host in the file, delete the file: rm ' + JSON.stringify(store) + ')',
    '    3. Run the pairing command printed by the installer, or simply re-run the installer.',
  ].join('\n'));
  process.exit(PAIRING_DEFERRED_EXIT);
}
interface Auth { authenticated: boolean; admin: boolean; principalKind: string; principalId: string; scopes: string[] }
async function invoke<T = unknown>(token: string, method: string, body: object = {}): Promise<T> {
  const response = await fetch(`${host}/api/control-plane/methods/${method}/invoke`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Installed daemon ${method} failed: HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}
async function verify(pairing: TuiHostPairingSecret): Promise<void> {
  const auth = await invoke<Auth>(pairing.token, 'control.auth.current');
  if (!auth.authenticated || !auth.admin || auth.principalKind !== 'token' || auth.principalId !== `pairing:${pairing.tokenId}`
    || !['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes?.includes(scope) || auth.scopes?.includes('*'))) {
    throw new Error('Installed TUI credential lacks native conversation access.');
  }
}
const existing = readTuiHostPairing(home, host);
if (existing.status === 'paired') {
  await verify(existing);
} else {
  if (existing.status !== 'missing') {
    defer(existing.status === 'unknown'
      ? `an earlier pairing attempt for this host (attempt ${existing.attemptId}, started ${new Date(existing.startedAt).toISOString()}) never completed, and the installer will not replace an uncertain credential.`
      : 'the saved TUI credential store could not be read safely, and the installer will not replace an uncertain credential.');
  }
  const bootstrap = readTuiLegacyPairingBootstrap(home);
  if (!bootstrap) throw new Error('Installed daemon bootstrap credential is unavailable.');
  const auth = await invoke<Auth>(bootstrap, 'control.auth.current');
  if (!auth.authenticated || !auth.admin || auth.principalId !== 'shared-token') throw new Error('Installed daemon bootstrap authority is unavailable.');
  const attemptId = randomUUID(), name = 'GoodVibes installed TUI';
  const begun = await beginTuiHostPairing(home, host, { attemptId, name, startedAt: Date.now() });
  if (begun.status !== 'begun') defer(`the saved pairing state for this host changed or is unavailable (${begun.status}); it was left as found.`);
  const pairing = await (async (): Promise<TuiHostPairingSecret> => {
    try {
      const result = await invoke<{ token: { id: string; token: string; name: string; createdAt: number } }>(bootstrap, 'pairing.tokens.migrate', { name });
      const minted = result.token;
      if (!minted || !/^pair-[0-9a-f-]{36}$/i.test(minted.id) || !/^gvp_[A-Za-z0-9_-]{32}$/.test(minted.token)
        || minted.name !== name || !Number.isSafeInteger(minted.createdAt) || minted.createdAt <= 0) throw new Error('Invalid daemon pairing response.');
      const secret = { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt };
      const saved = await completeTuiHostPairing(home, host, attemptId, secret);
      if (saved.status !== 'paired') throw new Error('Could not save TUI pairing.');
      return secret;
    } catch (error) {
      return defer(`attempt ${attemptId} was recorded and then failed (${error instanceof Error ? error.message : String(error)}); the record was left in place because a token may already have been minted.`);
    }
  })();
  await verify(pairing);
}
const pairing = readTuiHostPairing(home, host);
if (pairing.status !== 'paired') throw new Error('Installed TUI connection changed.');
await invoke(pairing.token, 'workspaces.registrations.add', { root: realpathSync(workspaceArg), origin: 'installer', label: 'Installed daemon workspace' });
await invoke(pairing.token, 'workLedger.intake.get', { inputId: 'installation-readiness-check' });
console.log('Installed TUI connection and conversation workspace verified.');
