/**
 * state-carry-forward.ts, the Agent's own plugin state carried into the one
 * plugin state, once.
 *
 * Up to 3.5.0 the Agent kept which plugins were switched on, their
 * quarantines and their publisher keys in `~/.goodvibes/agent/plugins.json`,
 * and the terminal app and the daemon in `~/.goodvibes/tui/plugins.json`. Now
 * every program reads and writes the daemon's file (runtime/client-services.ts,
 * runtime-graph.ts). At the daemon's first start of this version the Agent's
 * file is read and what the daemon's file does not say yet is added to it: a
 * plugin switched on (with the folder it was switched on from), a quarantine,
 * a publisher key, a plugin's settings. Nothing the daemon's file says is
 * changed, nothing is removed, and the Agent's file is left as it was, so a
 * 3.5.0 Agent started after a rollback reads its own file as before (a change
 * made after the upgrade is not in it). A record beside the daemon's file
 * makes it once.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

const RECORD = 'plugins-carried-forward.json';

type Section = Record<string, unknown>;
interface StateFile { enabled?: Section; enabledDirs?: Section; config?: Section; quarantine?: Section; publisherKeys?: Section; trust?: Section; [key: string]: unknown }

function readState(path: string): StateFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StateFile : undefined;
  } catch {
    return undefined;
  }
}

const section = (value: unknown): Section => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Section : {};

/**
 * Carry `~/.goodvibes/agent/plugins.json` into `~/.goodvibes/tui/plugins.json`
 * once. Answers the plugin names carried (empty when there was nothing, or it
 * was done before).
 */
export function carryAgentPluginStateForward(goodvibesTree: string): readonly string[] {
  const target = join(goodvibesTree, 'tui', 'plugins.json');
  const record = join(dirname(target), RECORD);
  if (existsSync(record)) return [];
  const agent = readState(join(goodvibesTree, 'agent', 'plugins.json'));
  const carried = new Set<string>();
  try {
    if (agent) {
      const current = readState(target) ?? {};
      if (existsSync(target) && readState(target) === undefined) {
        // An unreadable state file is left for the plugin manager's own recovery; nothing is written over it.
        logger.warn('plugin state carry-forward: the plugin state file could not be read; nothing was carried', { target });
        return [];
      }
      const next: StateFile = { ...current };
      for (const key of ['enabled', 'enabledDirs', 'config', 'quarantine', 'publisherKeys'] as const) {
        const mine = { ...section(current[key]) };
        for (const [name, value] of Object.entries(section(agent[key]))) {
          if (name in mine) continue;
          mine[name] = value;
          carried.add(name);
        }
        next[key] = mine;
      }
      if (carried.size > 0) writeJsonFileAtomic(target, next, { trailingNewline: false });
    }
    writeJsonFileAtomic(record, { version: 1, at: Date.now(), carried: [...carried].sort() }, { trailingNewline: true });
  } catch (error) {
    // Tried again at the next start: no record is written when the carry did not finish.
    logger.warn('plugin state carry-forward did not finish', { error: summarizeError(error) });
    return [];
  }
  return [...carried].sort();
}
