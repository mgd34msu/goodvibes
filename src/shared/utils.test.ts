// ============================================================================
// UTILITY FUNCTION TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatNumber,
  formatCost,
  formatDuration,
  formatRelativeTime,
  decodeProjectName,
} from './utils';

describe('formatNumber', () => {
  it('formats small numbers without abbreviation', () => {
    expect(formatNumber(123)).toBe('123');
    expect(formatNumber(999)).toBe('999');
  });

  it('formats thousands with comma separator', () => {
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1500)).toBe('1,500');
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber(999999)).toBe('999,999');
  });

  it('formats millions with M suffix', () => {
    expect(formatNumber(1000000)).toBe('1.00M');
    expect(formatNumber(2500000)).toBe('2.50M');
  });

  it('formats billions with B suffix', () => {
    expect(formatNumber(1000000000)).toBe('1.00B');
    expect(formatNumber(1500000000)).toBe('1.50B');
  });

  it('formats trillions with T suffix', () => {
    expect(formatNumber(1000000000000)).toBe('1.00T');
    expect(formatNumber(2500000000000)).toBe('2.50T');
  });

  it('handles zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('handles null and undefined', () => {
    expect(formatNumber(null)).toBe('0');
    expect(formatNumber(undefined)).toBe('0');
  });
});

describe('formatCost', () => {
  it('formats cost with dollar sign and 2 decimal places', () => {
    expect(formatCost(1.2345)).toBe('$1.23');
    expect(formatCost(0.0001)).toBe('$0.00');
    expect(formatCost(100)).toBe('$100.00');
    expect(formatCost(3.567)).toBe('$3.57');
  });

  it('formats large costs with thousands separators', () => {
    expect(formatCost(1234.56)).toBe('$1,234.56');
    expect(formatCost(1234567.89)).toBe('$1,234,567.89');
    expect(formatCost(12345)).toBe('$12,345.00');
  });

  it('handles zero cost', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('handles null and undefined', () => {
    expect(formatCost(null)).toBe('$0.00');
    expect(formatCost(undefined)).toBe('$0.00');
  });
});

describe('formatDuration', () => {
  it('formats seconds under a minute', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats recent times as "just now"', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('formats minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
  });

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
  });

  it('formats days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
  });
});

describe('decodeProjectName', () => {
  it('decodes encoded project paths', () => {
    // Windows path encoded style
    const result = decodeProjectName('C--Users-dev-projects-myapp');
    expect(result).toBe('myapp');
  });

  it('handles simple strings', () => {
    expect(decodeProjectName('myproject')).toBe('myproject');
    expect(decodeProjectName('test')).toBe('test');
  });

  it('handles null/undefined', () => {
    expect(decodeProjectName(null)).toBe('Unknown');
    expect(decodeProjectName(undefined)).toBe('Unknown');
  });

  it('decodes with projectsRoot parameter', () => {
    const result = decodeProjectName(
      'C--Users-buzzkill-Documents-work-api',
      'C:\\Users\\buzzkill\\Documents'
    );
    expect(result).toBe('work/api');
  });
});

describe('decodeProjectName extension handling', () => {
  it('converts extension-like folder names to dotted format with projectsRoot', () => {
    expect(decodeProjectName(
      '-home-buzzkill-Projects-goodvibes-sh',
      '/home/buzzkill/Projects'
    )).toBe('goodvibes.sh');
  });

  it('converts extension-like folder names without projectsRoot', () => {
    expect(decodeProjectName('-home-buzzkill-Projects-goodvibes-sh')).toBe('goodvibes.sh');
  });

  it('handles nested paths with extensions', () => {
    expect(decodeProjectName(
      '-home-buzzkill-Projects-apps-myapp-ts',
      '/home/buzzkill/Projects'
    )).toBe('apps/myapp.ts');
  });

  it('does not convert non-extension endings', () => {
    expect(decodeProjectName(
      '-home-buzzkill-Projects-myproject',
      '/home/buzzkill/Projects'
    )).toBe('myproject');
  });

  it('handles Windows paths with extension logic', () => {
    expect(decodeProjectName(
      'C--Users-buzzkill-Documents-goodvibes-sh',
      'C:\\Users\\buzzkill\\Documents'
    )).toBe('goodvibes.sh');
  });

  it('handles Windows nested paths with extensions', () => {
    expect(decodeProjectName(
      'C--Users-buzzkill-Documents-apps-myapp-ts',
      'C:\\Users\\buzzkill\\Documents'
    )).toBe('apps/myapp.ts');
  });

  it('handles folder names with hyphens (not extensions)', () => {
    // This is the bug fix: "goodvibes-plugin" should not become "goodvibes/plugin"
    expect(decodeProjectName(
      '-home-buzzkill-Projects-goodvibes-plugin',
      '/home/buzzkill/Projects'
    )).toBe('goodvibes-plugin');
  });

  it('handles multi-level nested paths correctly', () => {
    // Multi-level paths (3+ components) are ambiguous - we keep them as nested paths
    // since we can't determine if "apps-frontend-dashboard" is one folder or three without filesystem access
    expect(decodeProjectName(
      '-home-buzzkill-Projects-apps-frontend-dashboard',
      '/home/buzzkill/Projects'
    )).toBe('apps/frontend/dashboard');
  });
});
