import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractStore, ContractStoreVersionError, contractPath } from '../../platform/src/platform/contract/store.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION } from '../../platform/src/platform/contract/types.js';
import * as observation from '../../platform/src/platform/utils/file-observation.js';
import { makeContract } from './fixtures.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-checkpoint-version-'));
  const contract = makeContract();
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  store.hold(contract);
  return { root, contract, store, path: contractPath(root, contract.id) };
}

test('repeated native checkpoint writes do not parse their own full published image again', () => {
  const f = fixture(), parse = spyOn(JSON, 'parse');
  try {
    expect(f.store.write(f.contract.id)).toBe(true);
    f.store.hold(f.contract);
    expect(f.store.write(f.contract.id)).toBe(true);
    f.store.hold(f.contract);
    expect(parse).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toContain(`"schemaVersion":${CURRENT_CONTRACT_SCHEMA_VERSION}`);
  } finally { parse.mockRestore(); f.store.dispose(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const replacement of ['rename', 'rewrite-restored-mtime'] as const) {
  test(`a foreign future checkpoint invalidates an owned write receipt after ${replacement}`, () => {
    const f = fixture();
    try {
      expect(f.store.write(f.contract.id)).toBe(true);
      const previous = statSync(f.path);
      const future = readFileSync(f.path, 'utf8').replace(`"schemaVersion":${CURRENT_CONTRACT_SCHEMA_VERSION}`, `"schemaVersion":${CURRENT_CONTRACT_SCHEMA_VERSION + 1}`);
      if (replacement === 'rename') { writeFileSync(`${f.path}.replacement`, future); renameSync(`${f.path}.replacement`, f.path); }
      else { writeFileSync(f.path, future); utimesSync(f.path, previous.atime, previous.mtime); }
      expect(() => f.store.hold(f.contract)).toThrow(ContractStoreVersionError);
      expect(f.store.write(f.contract.id)).toBe(false);
      expect(readFileSync(f.path, 'utf8')).toBe(future);
    } finally { f.store.dispose(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('a foreign replacement during publication cannot acquire the native writer version receipt', () => {
  const f = fixture(), identity = observation.fileObservationIdentity;
  let replaced = false;
  const tap = spyOn(observation, 'fileObservationIdentity').mockImplementation(path => {
    const captured = identity(path);
    if (path === f.path && !replaced) {
      replaced = true;
      writeFileSync(path, JSON.stringify({ schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION + 1, contract: f.contract }));
    }
    return captured;
  });
  try {
    expect(f.store.write(f.contract.id)).toBe(false);
    expect(replaced).toBe(true);
    expect(() => f.store.hold(f.contract)).toThrow(ContractStoreVersionError);
  } finally { tap.mockRestore(); f.store.dispose(); rmSync(f.root, { recursive: true, force: true }); }
});

test('an identical-byte foreign copy is independently parsed before its version can be reused', () => {
  const f = fixture();
  try {
    expect(f.store.write(f.contract.id)).toBe(true);
    writeFileSync(`${f.path}.copy`, readFileSync(f.path)); renameSync(`${f.path}.copy`, f.path);
    const parse = spyOn(JSON, 'parse');
    try {
      f.store.hold(f.contract);
      expect(parse).toHaveBeenCalledTimes(1);
      f.store.hold(f.contract);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  } finally { f.store.dispose(); rmSync(f.root, { recursive: true, force: true }); }
});
