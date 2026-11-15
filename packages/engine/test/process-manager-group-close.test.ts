import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { waitFor } from './_helpers/test-timeout.js';
useToolReadings([['', { credential: true }]]);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

if (process.platform !== 'win32') {
  for (const [exitEarly, external, stopFirst] of [[false, false, false], [false, false, true], [true, false, false], [true, true, false]] as const) {
    test(`POSIX close drains owned shell descendants: leader exited=${exitEarly}, external=${external}, explicit stop=${stopFirst}`, async () => {
      const directory = makeProjectTempDir('process-group-close');
      const pidFile = join(directory, 'pid');
      const manager = new ProcessManager();
      // A fixture-owned descendant deliberately ignores SIGTERM and inherits
      // the shell pipes; its own pid is how the test sees whether it survived.
      const code = `process.on('SIGTERM',()=>{}); const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(process.pid)); fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)}); setInterval(()=>{},1000);`;
      let descendant: number | undefined;
      try {
        const child = await manager.spawn(`${quote(process.execPath)} --no-env-file -e ${quote(code)} & ${exitEarly ? `while [ ! -f ${quote(pidFile)} ]; do /bin/sleep 0.01; done; exit 0` : 'wait'}`,
          directory, undefined, { timeout_ms: 12_000, sigterm_grace_ms: 20, kill_on_timeout: !external });
        // The file is renamed into place, so it is never seen empty or partial.
        await waitFor(() => existsSync(pidFile));
        if (exitEarly) await waitFor(() => manager.getStatus(child.process_id!)?.done === true);
        const status = manager.getStatus(child.process_id!)!;
        if (stopFirst) expect(manager.stop(child.process_id!)).toBe(true);
        descendant = Number(readFileSync(pidFile, 'utf8'));
        expect(Number.isInteger(descendant) && descendant > 1).toBe(true);
        await manager.close();
        expect(status.done).toBe(true);
        // A descendant of an externally owned group is left running; otherwise close reaps it.
        if (external) expect(alive(descendant)).toBe(true);
        else await waitFor(() => !alive(descendant!));
      } finally {
        await manager.close();
        if (descendant !== undefined && alive(descendant)) process.kill(descendant, 'SIGKILL');
      }
    }, 10_000);
  }
} else {
  console.warn('[coverage] POSIX owned process-group shutdown is unavailable on Windows; only direct child handles are owned there.');
}
