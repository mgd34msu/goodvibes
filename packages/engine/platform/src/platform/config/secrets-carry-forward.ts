/**
 * secrets-carry-forward.ts: the secrets each terminal program kept for itself
 * before this release, carried into the daemon's own store.
 *
 * Up to 3.5.0 a secret stored "for all your projects" went into the asking
 * program's own store (`~/.goodvibes/tui/secrets.enc`, `~/.goodvibes/agent/
 * secrets.enc`, and their plain-text twins `~/.goodvibes/tui.secrets.json`,
 * `agent.secrets.json`). From this release that choice is the daemon's store
 * (`~/.goodvibes/daemon/secrets.enc`, `secrets.json`), which every program
 * reads first. The first time a daemon of this release starts, each program's
 * secrets are copied there, so the stores agree from then on:
 *
 *  - a name held by one program, or by both with the same value, is copied to
 *    the daemon's store, encrypted when any program held it encrypted;
 *  - a name the daemon's store already holds is left as it is (it already led
 *    every read);
 *  - a name the two programs hold with different values is not copied: each
 *    program keeps reading its own, and the owner is told which names to
 *    settle.
 *
 * Nothing is removed and the programs' files are not written, so 3.5.0 still
 * reads every one of them: it reads the daemon's store first too, finds there
 * the very values its own store holds, and resolves every name as it did.
 *
 * A return to an earlier release: a 3.5.0 `/secrets set` of a carried name
 * writes the program's own store, which the daemon's copy shadows. So the record
 * of the carry (`<daemon home>/secrets-carried-forward.json`) keeps, for each
 * carried name, a fingerprint of the value each program's own file held (an
 * HMAC under a key of this daemon's, `secrets-carried-forward.key`; never the
 * value). At every later start, the carried names alone are read again from the
 * programs' own files and compared with their fingerprints: a name whose value
 * changed there (set by the earlier release) is carried again as that newer
 * value, and the owner is told once which name changed. Nothing else is read or
 * compared.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SecretsManager } from './secrets.js';
import type { SecretStorageMedium } from './secrets-store-paths.js';

/** The programs that kept secrets of their own before this release. */
export const SECRET_CARRY_PROGRAMS = ['tui', 'agent'] as const;

export interface SecretsCarryForward {
  /** Copied to the daemon's store, with the programs it came from. */
  readonly carried: readonly { readonly key: string; readonly from: readonly string[]; readonly medium: SecretStorageMedium }[];
  /** Held by the programs with different values: not copied, each program keeps its own. */
  readonly differing: readonly string[];
  /** Already in the daemon's store: left as it is. */
  readonly kept: readonly string[];
  /** Could not be read (an unreadable store): nothing of it was copied. */
  readonly unreadable: readonly string[];
  /** At a later start: carried names whose value an earlier release changed in a program's own file, carried again. */
  readonly changed?: readonly string[] | undefined;
  /** At a later start: carried names both programs changed, to different values: the daemon's copy was left. */
  readonly changedApart?: readonly string[] | undefined;
}

export interface SecretsCarryForwardOptions {
  readonly globalHome: string;
  readonly daemonHome: string;
  readonly programs?: readonly string[] | undefined;
}

/** What the record keeps: names, and per carried name a fingerprint of each program's value. Never a value. */
interface CarryRecord {
  readonly version: 2;
  readonly carriedAt: string;
  readonly carried: readonly string[];
  readonly differing: readonly string[];
  readonly kept: readonly string[];
  readonly fingerprints: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The record that makes the carry happen once, and holds the carried names' fingerprints. */
export function secretsCarryForwardRecordPath(daemonHome: string): string {
  return join(daemonHome, 'secrets-carried-forward.json');
}

/** The owner's one line about a carry, or undefined when nothing needs saying. */
export function describeSecretsCarryForward(result: SecretsCarryForward): string | undefined {
  const lines: string[] = [];
  if (result.carried.length > 0) {
    lines.push(`Your stored secrets (${result.carried.map((entry) => entry.key).join(', ')}) are now kept in the daemon's secret store, which every GoodVibes program reads; the programs' own copies were left as they were.`);
  }
  if (result.differing.length > 0) {
    lines.push(`The terminal app and the Agent hold different values for ${result.differing.join(', ')}, so each keeps its own; store the one you want with "Store a secret" (Permissions and safety, Secrets) for all your projects and both use it.`);
  }
  if ((result.changed ?? []).length > 0) {
    lines.push(`${result.changed!.join(', ')} ${result.changed!.length === 1 ? 'was' : 'were'} changed while an earlier GoodVibes version was running; every program now uses the new value.`);
  }
  if ((result.changedApart ?? []).length > 0) {
    lines.push(`${result.changedApart!.join(', ')} ${result.changedApart!.length === 1 ? 'was' : 'were'} changed to different values in the terminal app and the Agent while an earlier version was running; each program now uses the value stored before. Store the one you want with "Store a secret" (Permissions and safety, Secrets) for all your projects.`);
  }
  if (result.unreadable.length > 0) lines.push(`A secret store could not be read (${result.unreadable.join(', ')}); nothing in it was moved.`);
  return lines.length > 0 ? lines.join(' ') : undefined;
}

/** The key fingerprints are made with, kept beside the record (made once, readable by the owner alone). */
function fingerprintKey(daemonHome: string): Buffer {
  const path = join(daemonHome, 'secrets-carried-forward.key');
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600 });
  return key;
}

function fingerprintOf(key: Buffer, name: string, value: string): string {
  return createHmac('sha256', key).update(name).update('\u0000').update(value).digest('hex');
}

function readRecord(path: string): CarryRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CarryRecord>;
    return parsed && typeof parsed === 'object' ? {
      version: 2, carriedAt: String(parsed.carriedAt ?? ''), carried: parsed.carried ?? [], differing: parsed.differing ?? [],
      kept: parsed.kept ?? [], fingerprints: parsed.fingerprints ?? {},
    } : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(path: string, record: CarryRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

interface HeldValue { readonly program: string; readonly value: string; readonly medium: SecretStorageMedium }

/**
 * Carry each program's own secrets to the daemon's store, once; at a later start, carry again only a carried name an
 * earlier release changed in a program's own file. Answers undefined when nothing was done. The record is written
 * only after every copy landed, so a start that stops part way copies again.
 */
export async function carryProgramSecretsToDaemon(options: SecretsCarryForwardOptions): Promise<SecretsCarryForward | undefined> {
  const recordPath = secretsCarryForwardRecordPath(options.daemonHome);
  const programs = options.programs ?? SECRET_CARRY_PROGRAMS;
  // No project is read: each manager's project store is a folder that holds none.
  const managerFor = (surfaceRoot: string) => new SecretsManager({
    projectRoot: options.daemonHome, globalHome: options.globalHome, surfaceRoot, daemonHome: options.daemonHome, policy: 'preferred_secure',
  });
  /** One program's own value of `key` (the encrypted entry first, as its reads see it), or undefined. */
  const ownValue = async (manager: SecretsManager, program: string, key: string): Promise<HeldValue | undefined> => {
    const entries = await manager.readWriteScopeEntries(key, 'user');
    const secret = entries.secure ?? entries.plaintext;
    return secret ? { program, value: secret.reveal('store-write'), medium: entries.secure ? 'secure' : 'plaintext' } : undefined;
  };
  const record = existsSync(recordPath) ? readRecord(recordPath) : undefined;
  if (existsSync(recordPath)) return record ? recarryChanged(record) : undefined;

  const daemon = managerFor('daemon');
  const found = new Map<string, HeldValue[]>();
  const unreadable: string[] = [];
  try {
    for (const program of programs) {
      const manager = managerFor(program);
      try {
        let records: Awaited<ReturnType<SecretsManager['listDetailed']>>;
        try {
          records = await manager.listDetailed();
        } catch {
          unreadable.push(program);
          continue;
        }
        for (const key of [...new Set(records.filter((entry) => entry.scope === 'user').map((entry) => entry.key))]) {
          let held: HeldValue | undefined;
          try {
            held = await ownValue(manager, program, key);
          } catch {
            if (!unreadable.includes(program)) unreadable.push(program);
            continue;
          }
          if (held) found.set(key, [...(found.get(key) ?? []), held]);
        }
      } finally {
        manager.close();
      }
    }
    const key = fingerprintKey(options.daemonHome);
    const carried: { key: string; from: string[]; medium: SecretStorageMedium }[] = [];
    const differing: string[] = [];
    const kept: string[] = [];
    const fingerprints: Record<string, Record<string, string>> = {};
    for (const [name, held] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      const inDaemon = await daemon.readWriteScopeEntries(name, 'daemon');
      if (inDaemon.secure || inDaemon.plaintext) { kept.push(name); continue; }
      if (new Set(held.map((entry) => entry.value)).size > 1) { differing.push(name); continue; }
      const medium: SecretStorageMedium = held.some((entry) => entry.medium === 'secure') ? 'secure' : 'plaintext';
      await daemon.set(name, held[0]!.value, { scope: 'daemon', medium });
      carried.push({ key: name, from: held.map((entry) => entry.program), medium });
      fingerprints[name] = Object.fromEntries(held.map((entry) => [entry.program, fingerprintOf(key, name, entry.value)]));
    }
    // A store that could not be read is tried again next start.
    if (unreadable.length === 0) {
      writeRecord(recordPath, { version: 2, carriedAt: new Date().toISOString(), carried: carried.map((entry) => entry.key), differing, kept, fingerprints });
    }
    return { carried, differing, kept, unreadable };
  } finally {
    daemon.close();
  }

  /** A later start: only the carried names, only in the programs' own files, against their fingerprints. */
  async function recarryChanged(previous: CarryRecord): Promise<SecretsCarryForward | undefined> {
    const names = Object.keys(previous.fingerprints);
    if (names.length === 0) return undefined;
    const key = fingerprintKey(options.daemonHome);
    const newer = new Map<string, HeldValue[]>();
    const unreadableNow: string[] = [];
    for (const program of programs) {
      const manager = managerFor(program);
      try {
        for (const name of names) {
          const known = previous.fingerprints[name]?.[program];
          let held: HeldValue | undefined;
          try {
            held = await ownValue(manager, program, name);
          } catch {
            if (!unreadableNow.includes(program)) unreadableNow.push(program);
            continue;
          }
          // A value the program's file still holds as carried, or one it no longer holds, is not a change.
          if (!held || fingerprintOf(key, name, held.value) === known) continue;
          newer.set(name, [...(newer.get(name) ?? []), held]);
        }
      } finally {
        manager.close();
      }
    }
    if (newer.size === 0) return unreadableNow.length > 0 ? { carried: [], differing: [], kept: [], unreadable: unreadableNow } : undefined;
    const daemon = managerFor('daemon');
    const changed: string[] = [];
    const changedApart: string[] = [];
    const fingerprints: Record<string, Record<string, string>> = Object.fromEntries(
      Object.entries(previous.fingerprints).map(([name, byProgram]) => [name, { ...byProgram }]));
    try {
      for (const [name, held] of [...newer].sort(([a], [b]) => a.localeCompare(b))) {
        // Each changed program's value is remembered, so the same change is carried, and said, once.
        for (const entry of held) fingerprints[name] = { ...fingerprints[name], [entry.program]: fingerprintOf(key, name, entry.value) };
        if (new Set(held.map((entry) => entry.value)).size > 1) { changedApart.push(name); continue; }
        await daemon.set(name, held[0]!.value, { scope: 'daemon', medium: held.some((entry) => entry.medium === 'secure') ? 'secure' : 'plaintext' });
        changed.push(name);
      }
    } finally {
      daemon.close();
    }
    writeRecord(recordPath, { ...previous, fingerprints });
    return { carried: [], differing: [], kept: [], unreadable: unreadableNow, changed, changedApart };
  }
}
