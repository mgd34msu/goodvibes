import { describe, expect, test } from 'bun:test';
import { classifyCameraError, type ScannerFailure } from './pairing-qr-camera';

const named = (name: string) => Object.assign(new Error('browser-specific wording'), { name });

describe('classifyCameraError', () => {
  test.each<[string, ScannerFailure]>([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-camera'],
    ['DevicesNotFoundError', 'no-camera'],
    ['OverconstrainedError', 'no-camera'],
    ['NotReadableError', 'camera-busy'],
    ['TrackStartError', 'camera-busy'],
    ['AbortError', 'camera-failed'],
  ])('%s is %s', (name, failure) => {
    expect(classifyCameraError(named(name))).toBe(failure);
  });

  test('a thrown value that is not an Error is a generic camera failure', () => {
    expect(classifyCameraError('denied')).toBe('camera-failed');
    expect(classifyCameraError(undefined)).toBe('camera-failed');
  });
});
