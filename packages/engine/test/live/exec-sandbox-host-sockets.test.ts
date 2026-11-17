/**
 * Inside real bubblewrap, an ordinary command cannot connect to a host runtime
 * socket (a Unix socket outside the workspace), while it can still read the
 * resolver configuration it needs.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBwrapArgv, detectSandboxAvailability, probeSandboxHost } from '../../platform/src/platform/tools/exec/sandbox.js';
import { requireLiveHost } from '../_helpers/exec-containment-proof.ts';

// The same working-bubblewrap probe the sibling sandbox tests use: a bwrap that is
// installed but cannot create a namespace is a missing capability, not a failure.
const availability = detectSandboxAvailability(probeSandboxHost());
const bwrapPath = availability.bwrapPath;
// Looked up only where the sandbox bind-mounts the system tree, so the path is valid inside it.
const python = Bun.which('python3', { PATH: '/usr/bin:/bin' });
const hostReady = process.platform === 'linux' && availability.available && bwrapPath !== undefined && python !== null;
requireLiveHost('bubblewrap and python3', hostReady);
test('ordinary sandbox cannot connect to host runtime sockets', async () => {
  if (bwrapPath === undefined || python === null) throw new Error('host readiness was checked above');
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-socket-'));
  // /var/tmp was visible through the former root bind, unlike the isolated /tmp.
  const socket = `/var/tmp/gv-test-socket-${process.pid}-${randomUUID()}.sock`;
  let connections = 0;
  const server = createServer(client => { connections++; client.end(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const source = 'import socket,sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])';
    const control = Bun.spawn([python, '-c', source, socket], { stdout: 'pipe', stderr: 'pipe' });
    expect(await control.exited).toBe(0);
    expect(connections).toBe(1);
    const argv = buildBwrapArgv({ bwrapPath, workspaceDir: workspace, cwd: workspace,
      writableExtras: [], networkEnabled: true, resolverConfigPath: realpathSync('/etc/resolv.conf') });
    const child = Bun.spawn([...argv, python, '-c', source, socket], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain('FileNotFoundError');
    expect(connections).toBe(1);
    const dns = Bun.spawn([...argv, python, '-c', "open('/etc/resolv.conf').read()"], { stdout: 'pipe', stderr: 'pipe' });
    expect(await dns.exited).toBe(0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(socket, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
