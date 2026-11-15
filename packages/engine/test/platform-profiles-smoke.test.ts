/**
 * Profile data conversion: a config snapshot survives the trip into profile
 * data and back, field for field.
 */
import { describe, expect, test } from 'bun:test';
import { configSnapshotToProfileData, profileDataToConfigSnapshot } from '../platform/src/platform/profiles/index.js';

describe('platform/profiles: round trip', () => {
  test('a snapshot with profile settings comes back with the same values', () => {
    const snapshot = { 'display.stream': false, 'behavior.saveHistory': true };
    const profileData = configSnapshotToProfileData(snapshot);
    expect(profileData).toEqual({ display: { stream: false }, behavior: { saveHistory: true } });
    expect(profileDataToConfigSnapshot(profileData)).toEqual(snapshot);
  });

  test('an empty snapshot produces empty profile data', () => {
    expect(configSnapshotToProfileData({})).toEqual({});
    expect(profileDataToConfigSnapshot({})).toEqual({});
  });
});
