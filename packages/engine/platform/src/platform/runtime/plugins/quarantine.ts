/**
 * Plugin quarantine record.
 *
 * Plugins run inside this process, so a quarantined plugin is not running: the
 * plugin manager unloads it and refuses to load it again until the quarantine
 * is lifted. The record below is what the manager persists in its state file
 * to say so, and why.
 */

/** A plugin's quarantine, active or lifted. */
export interface QuarantineRecord {
  /** Plugin name. */
  readonly pluginName: string;
  /** Unix epoch ms when quarantine was applied. */
  readonly quarantinedAt: number;
  /** Human-readable reason for quarantine. */
  readonly reason: string;
  /** Whether the quarantine has been lifted. */
  readonly lifted: boolean;
  /** Unix epoch ms when quarantine was lifted, if applicable. */
  readonly liftedAt?: number | undefined;
}

/** Whether a record keeps its plugin from loading. */
export function isQuarantineActive(record: QuarantineRecord | undefined): boolean {
  return record !== undefined && !record.lifted;
}

/**
 * Reads persisted quarantine records, keeping only well-formed ones keyed by
 * their own plugin name. Fields written by older versions (the list of
 * capabilities it claimed to revoke) are dropped.
 */
export function readQuarantineRecords(raw: unknown): Record<string, QuarantineRecord> {
  const records: Record<string, QuarantineRecord> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return records;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const quarantinedAt = entry['quarantinedAt'];
    const reason = entry['reason'];
    const lifted = entry['liftedAt'];
    if (entry['pluginName'] !== name || typeof quarantinedAt !== 'number') continue;
    const liftedAt = typeof lifted === 'number' ? lifted : undefined;
    records[name] = {
      pluginName: name,
      quarantinedAt,
      reason: typeof reason === 'string' ? reason : 'quarantined',
      lifted: entry['lifted'] === true,
      ...(liftedAt !== undefined ? { liftedAt } : {}),
    };
  }
  return records;
}
