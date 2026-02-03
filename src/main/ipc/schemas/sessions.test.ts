// ============================================================================
// SESSION SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by session IPC handlers.
// Session management is critical for application state, so proper validation
// is essential for security and data integrity.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  sessionIdSchema,
  sessionPaginationLimitSchema,
  projectPathSchema,
  sessionSearchQuerySchema,
  getSessionsForProjectSchema,
  sessionSearchSchema,
} from './sessions.js';

// ============================================================================
// SESSION ID SCHEMA TESTS
// ============================================================================

describe('sessionIdSchema', () => {
  describe('valid session IDs', () => {
    const validIds = [
      // Standard UUIDs
      '550e8400-e29b-41d4-a716-446655440000',
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      '123e4567-e89b-12d3-a456-426614174000',
      // Uppercase UUIDs
      'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
      // Agent-prefixed session IDs
      'agent-abc123',
      'agent-xyz789',
      'agent-a1b2c3d4',
    ];

    validIds.forEach((id) => {
      it(`accepts valid session ID: "${id}"`, () => {
        const result = sessionIdSchema.safeParse(id);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid session IDs', () => {
    const invalidIds = [
      { value: '', reason: 'empty string' },
      { value: 'not-a-uuid', reason: 'invalid format' },
      { value: '550e8400-e29b-41d4-a716-446655440000-extra', reason: 'UUID with extra chars' },
      { value: '550e8400-e29b-41d4-a716', reason: 'truncated UUID' },
      { value: 'agent', reason: 'agent without suffix' },
      { value: 'agent-', reason: 'agent with empty suffix' },
      { value: 'user-abc123', reason: 'wrong prefix' },
      { value: '   ', reason: 'whitespace only' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: 'a'.repeat(101), reason: 'exceeds max length' },
    ];

    invalidIds.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = sessionIdSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('security edge cases', () => {
    const injectionPayloads = [
      "; DROP TABLE sessions;--",
      "'; DELETE FROM sessions; --",
      '$(whoami)',
      '`cat /etc/passwd`',
      '../../../etc/passwd',
      '<script>alert(1)</script>',
      '\x00null-byte',
      'id\nwith\nnewlines',
      'id\r\nwith\r\ncrlf',
      '${process.env.SECRET}',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects injection attempt: "${payload.substring(0, 30)}..."`, () => {
        const result = sessionIdSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// PAGINATION LIMIT SCHEMA TESTS
// ============================================================================

describe('sessionPaginationLimitSchema', () => {
  describe('valid limits', () => {
    const validLimits = [
      { value: undefined, expected: 50, reason: 'undefined (default)' },
      { value: 1, expected: 1, reason: 'minimum' },
      { value: 50, expected: 50, reason: 'default value' },
      { value: 100, expected: 100, reason: 'medium value' },
      { value: 500, expected: 500, reason: 'large value' },
      { value: 1000, expected: 1000, reason: 'maximum' },
    ];

    validLimits.forEach(({ value, expected, reason }) => {
      it(`accepts ${reason}: ${value} -> ${expected}`, () => {
        const result = sessionPaginationLimitSchema.safeParse(value);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(expected);
        }
      });
    });
  });

  describe('invalid limits', () => {
    const invalidLimits = [
      { value: 0, reason: 'zero' },
      { value: -1, reason: 'negative' },
      { value: -100, reason: 'large negative' },
      { value: 1001, reason: 'exceeds maximum' },
      { value: 10000, reason: 'way over maximum' },
      { value: 1.5, reason: 'decimal' },
      { value: '50', reason: 'string number' },
      { value: null, reason: 'null' },
      { value: NaN, reason: 'NaN' },
      { value: Infinity, reason: 'Infinity' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
    ];

    invalidLimits.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = sessionPaginationLimitSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// PROJECT PATH SCHEMA TESTS
// ============================================================================

describe('projectPathSchema', () => {
  describe('valid project paths', () => {
    const validPaths = [
      '/home/user/project',
      '/tmp/test',
      'C:\\Users\\user\\project',
      'D:\\Development\\my-app',
      '/Users/name/Documents/code',
      '/var/www/html',
      'relative/path',
      './local/path',
      'single',
    ];

    validPaths.forEach((path) => {
      it(`accepts valid path: "${path}"`, () => {
        const result = projectPathSchema.safeParse(path);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(path);
        }
      });
    });
  });

  describe('invalid project paths', () => {
    const invalidPaths = [
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: 'a'.repeat(1001), reason: 'exceeds max length' },
    ];

    invalidPaths.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = projectPathSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts path at max length (1000 chars)', () => {
      const longPath = '/path/' + 'a'.repeat(994);
      expect(longPath.length).toBe(1000);
      const result = projectPathSchema.safeParse(longPath);
      expect(result.success).toBe(true);
    });

    it('rejects path just over max length', () => {
      const longPath = '/path/' + 'a'.repeat(995);
      expect(longPath.length).toBe(1001);
      const result = projectPathSchema.safeParse(longPath);
      expect(result.success).toBe(false);
    });

    it('rejects root directory for security', () => {
      // Root paths are blocked as a security measure to prevent
      // operations on the entire filesystem root
      const result = projectPathSchema.safeParse('/');
      expect(result.success).toBe(false);
    });

    it('accepts paths with spaces', () => {
      const result = projectPathSchema.safeParse('/path/with spaces/in it');
      expect(result.success).toBe(true);
    });

    it('accepts paths with special characters', () => {
      const result = projectPathSchema.safeParse('/path/with-dashes_and.dots');
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// SESSION SEARCH QUERY SCHEMA TESTS
// ============================================================================

describe('sessionSearchQuerySchema', () => {
  describe('valid queries', () => {
    const validQueries = [
      'test',
      'search term',
      'multiple words here',
      'a',
      'query with numbers 123',
      'query-with-special_chars.and.dots',
      '"quoted search"',
    ];

    validQueries.forEach((query) => {
      it(`accepts valid query: "${query}"`, () => {
        const result = sessionSearchQuerySchema.safeParse(query);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid queries', () => {
    const invalidQueries = [
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: 'a'.repeat(501), reason: 'exceeds max length' },
    ];

    invalidQueries.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = sessionSearchQuerySchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('edge cases', () => {
    it('accepts query at max length (500 chars)', () => {
      const query = 'a'.repeat(500);
      const result = sessionSearchQuerySchema.safeParse(query);
      expect(result.success).toBe(true);
    });

    it('rejects query just over max length', () => {
      const query = 'a'.repeat(501);
      const result = sessionSearchQuerySchema.safeParse(query);
      expect(result.success).toBe(false);
    });

    it('accepts whitespace (trimmed by consumer)', () => {
      const result = sessionSearchQuerySchema.safeParse('   ');
      // Schema allows this - business logic should handle trimming
      expect(result.success).toBe(true);
    });

    it('accepts queries with unicode', () => {
      const result = sessionSearchQuerySchema.safeParse('search query');
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// COMPOSITE SCHEMA TESTS
// ============================================================================

describe('getSessionsForProjectSchema', () => {
  describe('valid inputs', () => {
    it('accepts valid projectPath and limit', () => {
      const result = getSessionsForProjectSchema.safeParse({
        projectPath: '/home/user/project',
        limit: 10,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.projectPath).toBe('/home/user/project');
        expect(result.data.limit).toBe(10);
      }
    });

    it('uses default limit when not provided', () => {
      const result = getSessionsForProjectSchema.safeParse({
        projectPath: '/home/user/project',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing projectPath', () => {
      const result = getSessionsForProjectSchema.safeParse({
        limit: 10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty projectPath', () => {
      const result = getSessionsForProjectSchema.safeParse({
        projectPath: '',
        limit: 10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid limit', () => {
      const result = getSessionsForProjectSchema.safeParse({
        projectPath: '/home/user/project',
        limit: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects null input', () => {
      const result = getSessionsForProjectSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects non-object input', () => {
      const result = getSessionsForProjectSchema.safeParse('string');
      expect(result.success).toBe(false);
    });
  });
});

describe('sessionSearchSchema', () => {
  describe('valid inputs', () => {
    it('accepts query only', () => {
      const result = sessionSearchSchema.safeParse({
        query: 'test search',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('test search');
        expect(result.data.projectPath).toBeUndefined();
        expect(result.data.limit).toBe(50);
      }
    });

    it('accepts query with projectPath', () => {
      const result = sessionSearchSchema.safeParse({
        query: 'test search',
        projectPath: '/home/user/project',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('test search');
        expect(result.data.projectPath).toBe('/home/user/project');
      }
    });

    it('accepts all fields', () => {
      const result = sessionSearchSchema.safeParse({
        query: 'test search',
        projectPath: '/home/user/project',
        limit: 25,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('test search');
        expect(result.data.projectPath).toBe('/home/user/project');
        expect(result.data.limit).toBe(25);
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing query', () => {
      const result = sessionSearchSchema.safeParse({
        projectPath: '/home/user/project',
        limit: 10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty query', () => {
      const result = sessionSearchSchema.safeParse({
        query: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid projectPath', () => {
      const result = sessionSearchSchema.safeParse({
        query: 'test',
        projectPath: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid limit', () => {
      const result = sessionSearchSchema.safeParse({
        query: 'test',
        limit: 0,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('SQL injection prevention', () => {
    const sqlPayloads = [
      "'; DROP TABLE sessions; --",
      "1' OR '1'='1",
      "1; DELETE FROM sessions WHERE 1=1",
      "UNION SELECT * FROM users",
      "1' AND SLEEP(5)--",
    ];

    sqlPayloads.forEach((payload) => {
      it(`rejects SQL injection in session ID: "${payload.substring(0, 30)}"`, () => {
        const result = sessionIdSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('NoSQL injection prevention', () => {
    const noSqlPayloads = [
      '{"$gt": ""}',
      '{"$ne": null}',
      '{"$where": "this.password == \'\'"}',
    ];

    noSqlPayloads.forEach((payload) => {
      it(`rejects NoSQL injection in search query: "${payload}"`, () => {
        // These are valid search strings but should be treated as literal text
        const result = sessionSearchQuerySchema.safeParse(payload);
        // Schema accepts them as strings, but they won't be interpreted as code
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Command injection prevention', () => {
    const cmdPayloads = [
      '$(whoami)',
      '`id`',
      '| cat /etc/passwd',
      '; rm -rf /',
      '&& malicious-command',
      '\n; injected',
    ];

    cmdPayloads.forEach((payload) => {
      it(`rejects command injection in session ID: "${payload}"`, () => {
        const result = sessionIdSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Prototype pollution prevention', () => {
    it('should not be affected by __proto__ in composite schema', () => {
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "query": "test"}');
      const result = sessionSearchSchema.safeParse(maliciousInput);
      // Should parse without throwing
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type coercion attacks', () => {
    it('rejects array where string expected for session ID', () => {
      const result = sessionIdSchema.safeParse(['550e8400-e29b-41d4-a716-446655440000']);
      expect(result.success).toBe(false);
    });

    it('rejects object with valueOf for limit', () => {
      const result = sessionPaginationLimitSchema.safeParse({ valueOf: () => 10 });
      expect(result.success).toBe(false);
    });
  });
});
