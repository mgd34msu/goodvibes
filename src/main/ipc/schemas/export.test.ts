// ============================================================================
// EXPORT SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by export IPC handlers.
// Verifies that the schemas correctly validate input and reject invalid data.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  exportSessionSchema,
  bulkExportSchema,
  addRecentProjectSchema,
  logActivitySchema,
} from './export.js';

// ============================================================================
// EXPORT SESSION SCHEMA TESTS
// ============================================================================

describe('exportSessionSchema', () => {
  describe('valid inputs', () => {
    const validFormats = ['markdown', 'json', 'html'];

    validFormats.forEach((format) => {
      it(`accepts valid UUID session ID with format "${format}"`, () => {
        const result = exportSessionSchema.safeParse({
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          format,
        });
        expect(result.success).toBe(true);
      });

      it(`accepts agent-prefixed session ID with format "${format}"`, () => {
        const result = exportSessionSchema.safeParse({
          sessionId: 'agent-abc123',
          format,
        });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing sessionId', () => {
      const result = exportSessionSchema.safeParse({
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing format', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid session ID format', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: 'invalid-session-id',
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid export format', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        format: 'pdf', // Not a valid format
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty session ID', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: '',
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = exportSessionSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects string instead of object', () => {
      const result = exportSessionSchema.safeParse('session-id');
      expect(result.success).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects session ID with SQL injection attempt', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: "'; DROP TABLE sessions;--",
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects session ID with command injection attempt', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: '$(whoami)',
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects session ID exceeding max length', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: 'a'.repeat(101),
        format: 'json',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// BULK EXPORT SCHEMA TESTS
// ============================================================================

describe('bulkExportSchema', () => {
  describe('valid inputs', () => {
    it('accepts empty array', () => {
      const result = bulkExportSchema.safeParse([]);
      expect(result.success).toBe(true);
    });

    it('accepts single session ID', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
      ]);
      expect(result.success).toBe(true);
    });

    it('accepts multiple session IDs', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440001',
        '550e8400-e29b-41d4-a716-446655440002',
      ]);
      expect(result.success).toBe(true);
    });

    it('accepts agent-prefixed session IDs', () => {
      const result = bulkExportSchema.safeParse([
        'agent-abc123',
        'agent-xyz789',
      ]);
      expect(result.success).toBe(true);
    });

    it('accepts mixed UUID and agent-prefixed session IDs', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        'agent-abc123',
      ]);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects null', () => {
      const result = bulkExportSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects string instead of array', () => {
      const result = bulkExportSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(false);
    });

    it('rejects object instead of array', () => {
      const result = bulkExportSchema.safeParse({
        sessionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      });
      expect(result.success).toBe(false);
    });

    it('rejects array with invalid session ID', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        'invalid-id',
      ]);
      expect(result.success).toBe(false);
    });

    it('rejects array with null element', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        null,
      ]);
      expect(result.success).toBe(false);
    });

    it('rejects array with empty string', () => {
      const result = bulkExportSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        '',
      ]);
      expect(result.success).toBe(false);
    });
  });

  describe('security edge cases', () => {
    it('rejects array with SQL injection attempt', () => {
      const result = bulkExportSchema.safeParse([
        "'; DROP TABLE sessions;--",
      ]);
      expect(result.success).toBe(false);
    });

    it('rejects array with command injection attempt', () => {
      const result = bulkExportSchema.safeParse([
        '$(rm -rf /)',
      ]);
      expect(result.success).toBe(false);
    });

    it('handles large array (DoS prevention should be handled elsewhere)', () => {
      // Creating 1000 valid session IDs
      const largeArray = Array.from({ length: 1000 }, (_, i) =>
        `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`
      );
      const result = bulkExportSchema.safeParse(largeArray);
      // Schema allows large arrays - rate limiting should be elsewhere
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// ADD RECENT PROJECT SCHEMA TESTS
// ============================================================================

describe('addRecentProjectSchema', () => {
  describe('valid inputs', () => {
    it('accepts path only', () => {
      const result = addRecentProjectSchema.safeParse({
        path: '/home/user/project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts path with name', () => {
      const result = addRecentProjectSchema.safeParse({
        path: '/home/user/project',
        name: 'My Project',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing path', () => {
      const result = addRecentProjectSchema.safeParse({
        name: 'Project',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty path', () => {
      const result = addRecentProjectSchema.safeParse({
        path: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = addRecentProjectSchema.safeParse({
        path: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding max length', () => {
      const result = addRecentProjectSchema.safeParse({
        path: '/valid/path',
        name: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// LOG ACTIVITY SCHEMA TESTS
// ============================================================================

describe('logActivitySchema', () => {
  describe('valid inputs', () => {
    it('accepts valid activity log with session ID', () => {
      const result = logActivitySchema.safeParse({
        type: 'session_start',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        description: 'User started a new session',
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid activity log with null session ID', () => {
      const result = logActivitySchema.safeParse({
        type: 'app_launch',
        sessionId: null,
        description: 'Application launched',
      });
      expect(result.success).toBe(true);
    });

    it('accepts activity log with metadata', () => {
      const result = logActivitySchema.safeParse({
        type: 'export_complete',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        description: 'Session exported successfully',
        metadata: { format: 'json', size: 1024 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts agent-prefixed session ID', () => {
      const result = logActivitySchema.safeParse({
        type: 'agent_task',
        sessionId: 'agent-abc123',
        description: 'Agent completed task',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing type', () => {
      const result = logActivitySchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        description: 'Some description',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty type', () => {
      const result = logActivitySchema.safeParse({
        type: '',
        sessionId: null,
        description: 'Description',
      });
      expect(result.success).toBe(false);
    });

    it('rejects type exceeding max length', () => {
      const result = logActivitySchema.safeParse({
        type: 'a'.repeat(101),
        sessionId: null,
        description: 'Description',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing description', () => {
      const result = logActivitySchema.safeParse({
        type: 'some_type',
        sessionId: null,
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty description', () => {
      const result = logActivitySchema.safeParse({
        type: 'some_type',
        sessionId: null,
        description: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects description exceeding max length', () => {
      const result = logActivitySchema.safeParse({
        type: 'some_type',
        sessionId: null,
        description: 'a'.repeat(5001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid session ID format', () => {
      const result = logActivitySchema.safeParse({
        type: 'some_type',
        sessionId: 'invalid-format',
        description: 'Description',
      });
      expect(result.success).toBe(false);
    });

    it('rejects null input', () => {
      const result = logActivitySchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('Session ID injection prevention', () => {
    const injectionPayloads = [
      "'; DROP TABLE sessions;--",
      "' OR '1'='1",
      '$(whoami)',
      '`id`',
      '${PATH}',
      '\'; DELETE FROM sessions; --',
      '1; SELECT * FROM users',
    ];

    injectionPayloads.forEach((payload) => {
      it(`exportSessionSchema rejects session ID with injection: ${payload.substring(0, 20)}...`, () => {
        const result = exportSessionSchema.safeParse({
          sessionId: payload,
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it(`bulkExportSchema rejects session ID with injection: ${payload.substring(0, 20)}...`, () => {
        const result = bulkExportSchema.safeParse([payload]);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Prototype pollution prevention', () => {
    it('should not be affected by __proto__ in exportSessionSchema', () => {
      const maliciousInput = JSON.parse(
        '{"__proto__": {"polluted": true}, "sessionId": "550e8400-e29b-41d4-a716-446655440000", "format": "json"}'
      );
      const result = exportSessionSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should not be affected by __proto__ in logActivitySchema', () => {
      const maliciousInput = JSON.parse(
        '{"__proto__": {"polluted": true}, "type": "test", "sessionId": null, "description": "test"}'
      );
      const result = logActivitySchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type coercion attacks', () => {
    it('rejects object with valueOf for sessionId', () => {
      const result = exportSessionSchema.safeParse({
        sessionId: { valueOf: () => '550e8400-e29b-41d4-a716-446655440000' },
        format: 'json',
      });
      expect(result.success).toBe(false);
    });

    it('rejects array where object expected', () => {
      const result = exportSessionSchema.safeParse([
        '550e8400-e29b-41d4-a716-446655440000',
        'json',
      ]);
      expect(result.success).toBe(false);
    });
  });
});
