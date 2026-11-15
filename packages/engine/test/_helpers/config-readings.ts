/**
 * A fake judgment port for the config layer's decisions, so tests of
 * credential routing and settings ingestion never call the live Jev API:
 * `config.credential-key` reads keys in `credentials` as a credential, every
 * other key as not one. Readings are strong (well past the bands), so every
 * one acts.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

export interface ConfigReadingTable {
  /** Keys that read as holding a credential. */
  readonly credentials?: readonly string[];
}

/** A port answering the config decisions from `table`, recording every request. */
export function configReadingsPort(table: ConfigReadingTable) {
  return fakePort((_name: string, _question: Question, state: EntryType) => {
    const key = (state as { readonly key?: string }).key ?? '';
    return noulAnswer(table.credentials?.includes(key) ? 0.97 : 0.03);
  });
}

/** Installs a {@link configReadingsPort} around every test in the calling file or block; returns its request log. */
export function useConfigReadings(table: ConfigReadingTable): { readonly requests: ReadonlyArray<{ readonly state: unknown }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port, requests } = configReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return log;
}
