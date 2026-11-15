/**
 * A crash message written while the alternate screen is up is erased when the
 * exit leaves that screen. The handler hands the terminal back first, then
 * writes the crash lines, then exits.
 */
import { expect, test } from 'bun:test';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createProcessFaultHandlers } from '../../runtime/process-fault-capture.ts';

test('an uncaught exception restores the terminal before writing the crash lines, then exits 1', () => {
  const home = makeProjectTempDir('crash-restore-order');
  const events: string[] = [];
  const handlers = createProcessFaultHandlers({
    notifyHigh: () => {},
    render: () => {},
    shellPaths: { resolveUserPath: (...segments: string[]) => [home, ...segments].join('/') },
    activeSessionId: () => 'session',
    restoreTerminal: () => { events.push('restore'); },
    writeStderr: (line) => { events.push(line.startsWith('goodvibes-agent crashed') ? 'crash-line' : 'record-line'); },
    exit: (code) => { events.push(`exit ${code}`); },
  });
  const saved = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  try {
    handlers.register();
    process.emit('uncaughtException', new Error('injected'));
  } finally {
    handlers.dispose();
    for (const listener of saved) process.on('uncaughtException', listener);
  }
  expect(events).toEqual(['restore', 'crash-line', 'record-line', 'exit 1']);
});
