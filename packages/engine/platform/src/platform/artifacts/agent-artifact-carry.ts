/**
 * agent-artifact-carry.ts, the Agent's saved artifacts carried once into the
 * daemon's artifact store, the one every program uses from this version on
 * (capabilities/builtin/artifacts.ts).
 *
 * Until this version the Agent kept its own store (`~/.goodvibes/agent/
 * artifacts/`) beside the daemon's and the terminal app's
 * (`~/.goodvibes/tui/artifacts/`). At the daemon's first start of this
 * version, before its store is opened, every artifact of the Agent's that the
 * daemon's store does not hold is copied into it under the same id (drafts,
 * review packets and notes name artifacts by id), with its record pointed at
 * the copy. Nothing is removed and the Agent's folder is not written, so an
 * earlier version of the Agent still finds every artifact it had. A record of
 * the carry beside the store (`agent-artifacts-carried.json`, ids only) makes
 * it once: an artifact an earlier Agent saves after a rollback stays in its
 * own folder.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface AgentArtifactCarry {
  readonly carried: readonly string[];
  readonly skipped: readonly string[];
}

/** The record of the carry, beside the daemon's store. */
export function agentArtifactCarryRecordPath(daemonRoot: string): string {
  return join(dirname(daemonRoot), 'agent-artifacts-carried.json');
}

/**
 * Copy the Agent's artifacts into the daemon's store folder, once. Runs before
 * the daemon's ArtifactStore reads its folder. Answers what was carried, or
 * undefined when it ran before or there is nothing of the Agent's.
 */
export function carryAgentArtifactsOnce(input: { readonly agentRoot: string; readonly daemonRoot: string; readonly now?: number | undefined }): AgentArtifactCarry | undefined {
  const record = agentArtifactCarryRecordPath(input.daemonRoot);
  if (existsSync(record) || !existsSync(input.agentRoot)) return undefined;
  const now = input.now ?? Date.now();
  const carried: string[] = [];
  const skipped: string[] = [];
  mkdirSync(input.daemonRoot, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(input.agentRoot).sort()) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    const metadataPath = join(input.agentRoot, entry);
    const contentPath = join(input.agentRoot, `${id}.data`);
    const targetMetadata = join(input.daemonRoot, entry);
    const targetContent = join(input.daemonRoot, `${id}.data`);
    try {
      // The daemon's own artifact of that id is kept; the Agent's is not copied over it.
      if (existsSync(targetMetadata) || existsSync(targetContent)) { skipped.push(id); continue; }
      const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
      if (parsed['id'] !== id || !existsSync(contentPath)) { skipped.push(id); continue; }
      if (typeof parsed['expiresAt'] === 'number' && parsed['expiresAt'] <= now) { skipped.push(id); continue; }
      copyFileSync(contentPath, targetContent);
      chmodSync(targetContent, 0o600);
      // The record is the Agent's, pointed at the copy (the store keeps a record and its content side by side).
      writeFileSync(targetMetadata, `${JSON.stringify({ ...parsed, contentPath: targetContent, metadataPath: targetMetadata }, null, 2)}\n`, { mode: 0o600 });
      carried.push(id);
    } catch (error) {
      skipped.push(id);
      logger.warn('[artifacts] an artifact of the Agent could not be carried into the daemon\'s store; it stays in the Agent\'s folder', { id, error: summarizeError(error) });
    }
  }
  writeFileSync(record, `${JSON.stringify({ version: 1, at: new Date(now).toISOString(), from: input.agentRoot, carried, skipped }, null, 2)}\n`, { mode: 0o600 });
  return { carried, skipped };
}
