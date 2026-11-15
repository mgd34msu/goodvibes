/**
 * device-settings-reachable.test.ts, the `device.*` config keys are reachable
 * and readable in the settings workspace.
 *
 * The paired-phone feature is configured entirely through config keys, so a key
 * that exists in the platform schema but never surfaces in this app is a feature the
 * owner cannot actually configure. This pins three things: every device key is
 * routed into a group, that group carries a real human label rather than a raw
 * namespace, and every key carries a written purpose long enough to be a
 * description rather than a restatement of its own name.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsModel, groupLabelForNamespace } from './settings-model';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';

const DEVICE_KEYS = CONFIG_SCHEMA_ENTRIES.filter((entry) => entry.key.startsWith('device.')).map((entry) => entry.key);

const MIN_DESCRIPTION_LENGTH = 40;

describe('paired-phone settings reachability', () => {
  test('every device key is routed into the settings workspace', () => {
    const groups = buildSettingsModel({});
    // A device key surfaces either as a plain row or as one of the paired-phone
    // feature's own fields; both are reachable, so both count.
    const routed = new Set(groups.flatMap((group) => [
      ...group.plainRows.map((row) => row.key),
      ...group.featureUnits.flatMap((unit) => [
        ...(unit.enablementField ? [unit.enablementField.key] : []),
        ...unit.fields.map((field) => field.key),
      ]),
    ]));
    expect(DEVICE_KEYS.filter((key) => !routed.has(key))).toEqual([]);
  });

  test('the device group carries a human label, not the raw namespace', () => {
    expect(groupLabelForNamespace('device')).toBe('Paired Phone Capabilities');
    const group = buildSettingsModel({}).find((entry) => entry.id === 'device');
    expect(group?.label).toBe('Paired Phone Capabilities');
  });

  test('every device key ships a written purpose, not a restatement of its name', () => {
    expect(DEVICE_KEYS.length).toBeGreaterThan(0);
    const terse = CONFIG_SCHEMA_ENTRIES
      .filter((entry) => DEVICE_KEYS.includes(entry.key) && entry.description.trim().length < MIN_DESCRIPTION_LENGTH)
      .map((entry) => entry.key);
    expect(terse).toEqual([]);
  });
});
