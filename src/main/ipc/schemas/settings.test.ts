// ============================================================================
// SETTINGS SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by settings and config IPC handlers.
// Verifies that the schemas correctly validate input and reject invalid data.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  settingKeySchema,
  settingUpdateSchema,
  appPathNameSchema,
  getSettingInputSchema,
  setSettingInputSchema,
  getAppPathInputSchema,
  validateInput,
  formatZodError,
} from './settings.js';
import { z, ZodError } from 'zod';

// ============================================================================
// SETTING KEY SCHEMA TESTS
// ============================================================================

describe('settingKeySchema', () => {
  describe('valid keys', () => {
    const validKeys = [
      'theme',
      'userSettings',
      'app_config',
      'setting123',
      'a',
      'APP',
      'my.nested.setting',
      'config_v2',
      'user_preferences_v1',
    ];

    validKeys.forEach((key) => {
      it(`accepts "${key}"`, () => {
        const result = settingKeySchema.safeParse(key);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid keys', () => {
    const invalidKeys = [
      { value: '', reason: 'empty string' },
      { value: '123start', reason: 'starts with number' },
      { value: '_private', reason: 'starts with underscore' },
      { value: 'has space', reason: 'contains space' },
      { value: 'has-dash', reason: 'contains dash' },
      { value: 'special@char', reason: 'contains special character' },
      { value: 'a'.repeat(101), reason: 'exceeds max length' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
    ];

    invalidKeys.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = settingKeySchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts single character key', () => {
      expect(settingKeySchema.safeParse('a').success).toBe(true);
    });

    it('accepts key at max length', () => {
      const key = 'a' + 'b'.repeat(99);
      expect(settingKeySchema.safeParse(key).success).toBe(true);
    });

    it('rejects key just over max length', () => {
      const key = 'a' + 'b'.repeat(100);
      expect(settingKeySchema.safeParse(key).success).toBe(false);
    });

    it('rejects whitespace-only strings', () => {
      expect(settingKeySchema.safeParse('   ').success).toBe(false);
    });
  });
});

// ============================================================================
// SETTING UPDATE SCHEMA TESTS
// ============================================================================

describe('settingUpdateSchema', () => {
  describe('valid updates', () => {
    const validUpdates = [
      { key: 'theme', value: 'dark' },
      { key: 'fontSize', value: 14 },
      { key: 'autoSave', value: true },
      { key: 'config', value: { nested: { data: 123 } } },
      { key: 'list', value: [1, 2, 3] },
      { key: 'nullable', value: null },
    ];

    validUpdates.forEach(({ key, value }) => {
      it(`accepts valid update with key="${key}" and value type=${typeof value}`, () => {
        const result = settingUpdateSchema.safeParse({ key, value });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid updates', () => {
    const invalidUpdates = [
      { data: { key: '', value: 'test' }, reason: 'empty key' },
      { data: { key: '123', value: 'test' }, reason: 'key starting with number' },
      // Note: { key: 'valid' } without value is valid because z.unknown() allows undefined
      { data: { value: 'test' }, reason: 'missing key' },
      { data: {}, reason: 'empty object' },
      { data: null, reason: 'null' },
      { data: 'string', reason: 'string instead of object' },
    ];

    invalidUpdates.forEach(({ data, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = settingUpdateSchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('value field behavior', () => {
    it('accepts undefined value (z.unknown() allows undefined)', () => {
      // This is by design - settings can be set to undefined to clear them
      const result = settingUpdateSchema.safeParse({ key: 'validKey' });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// APP PATH NAME SCHEMA TESTS
// ============================================================================

describe('appPathNameSchema', () => {
  describe('valid path names', () => {
    const validNames = [
      'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
      'module', 'desktop', 'documents', 'downloads', 'music',
      'pictures', 'videos', 'recent', 'logs', 'crashDumps',
    ];

    validNames.forEach((name) => {
      it(`accepts "${name}"`, () => {
        const result = appPathNameSchema.safeParse(name);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid path names', () => {
    const invalidNames = [
      { value: 'invalid', reason: 'not in enum' },
      { value: 'HOME', reason: 'wrong case' },
      { value: 'app-data', reason: 'dash instead of camelCase' },
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: 'root', reason: 'root path not allowed' },
      { value: '../etc', reason: 'path traversal attempt' },
      { value: '/etc/passwd', reason: 'absolute path' },
    ];

    invalidNames.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = appPathNameSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// VALIDATE INPUT HELPER TESTS
// ============================================================================

describe('validateInput', () => {
  it('returns success with data for valid input', () => {
    const result = validateInput(settingKeySchema, 'validKey');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('validKey');
    }
  });

  it('returns failure with error for invalid input', () => {
    const result = validateInput(settingKeySchema, '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(typeof result.error).toBe('string');
    }
  });

  it('includes details array for invalid input', () => {
    const result = validateInput(settingKeySchema, '');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.details).toBeDefined();
      expect(Array.isArray(result.details)).toBe(true);
    }
  });
});

// ============================================================================
// FORMAT ZOD ERROR TESTS
// ============================================================================

describe('formatZodError', () => {
  it('formats single error correctly', () => {
    const error = new ZodError([
      {
        code: 'custom',
        path: ['key'],
        message: 'Test error message',
      },
    ]);
    const formatted = formatZodError(error);
    expect(formatted).toBe('key: Test error message');
  });

  it('formats multiple errors correctly', () => {
    const error = new ZodError([
      { code: 'custom', path: ['field1'], message: 'Error 1' },
      { code: 'custom', path: ['field2'], message: 'Error 2' },
    ]);
    const formatted = formatZodError(error);
    expect(formatted).toBe('field1: Error 1; field2: Error 2');
  });

  it('handles nested paths correctly', () => {
    const error = new ZodError([
      { code: 'custom', path: ['parent', 'child'], message: 'Nested error' },
    ]);
    const formatted = formatZodError(error);
    expect(formatted).toBe('parent.child: Nested error');
  });

  it('handles empty path correctly', () => {
    const error = new ZodError([
      { code: 'custom', path: [], message: 'Root error' },
    ]);
    const formatted = formatZodError(error);
    expect(formatted).toBe('Root error');
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('settingKeySchema rejects injection attempts', () => {
    const injectionPayloads = [
      '; DROP TABLE settings;--',
      "'; DELETE FROM settings; --",
      '__proto__', // starts with underscore
      // Note: 'constructor' and 'prototype' are valid setting keys per regex
      // They start with a letter and contain only alphanumeric chars
      // Prototype pollution prevention should be handled at the database/runtime layer
      '${process.env}',
      '$(whoami)',
      '`cat /etc/passwd`',
      '<script>alert(1)</script>',
      '../../../etc/passwd',
      'key\x00value',
      'key\nvalue',
      'key\rvalue',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects injection payload: "${payload.substring(0, 30)}..."`, () => {
        const result = settingKeySchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('settingKeySchema allows valid alphanumeric keys (prototype pollution handled at runtime)', () => {
    // These are technically valid setting key names per the regex
    // Prototype pollution is handled at the database/runtime layer, not at validation
    const validButSensitiveKeys = ['constructor', 'prototype'];

    validButSensitiveKeys.forEach((key) => {
      it(`accepts "${key}" (valid regex, runtime protection handles pollution)`, () => {
        const result = settingKeySchema.safeParse(key);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('appPathNameSchema prevents path traversal', () => {
    const pathTraversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/root',
      'C:\\Windows\\System32',
      '~/.ssh/id_rsa',
      '/tmp/../etc/passwd',
    ];

    pathTraversalAttempts.forEach((attempt) => {
      it(`rejects path traversal: "${attempt}"`, () => {
        const result = appPathNameSchema.safeParse(attempt);
        expect(result.success).toBe(false);
      });
    });
  });
});
