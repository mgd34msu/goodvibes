// ============================================================================
// TERMINAL IPC HANDLER VALIDATION TESTS
// ============================================================================
//
// These tests verify that the terminal IPC handlers properly validate inputs
// using Zod schemas. This is critical for security since terminal operations
// can execute shell commands.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  terminalStartOptionsSchema,
  plainTerminalStartOptionsSchema,
  terminalInputSchema,
  terminalResizeSchema,
  terminalIdSchema,
} from '../schemas/terminal.js';

// ============================================================================
// TERMINAL START OPTIONS SCHEMA TESTS
// ============================================================================

describe('terminalStartOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = terminalStartOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept valid cwd path', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/project',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cwd).toBe('/home/user/project');
      }
    });

    it('should accept Windows path', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: 'C:\\Users\\user\\project',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid name', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'My Terminal',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Terminal');
      }
    });

    it('should accept valid UUID session ID', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should accept agent-prefixed session ID', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: 'agent-abc123',
      });
      expect(result.success).toBe(true);
    });

    it('should accept user session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'user',
      });
      expect(result.success).toBe(true);
    });

    it('should accept subagent session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'subagent',
      });
      expect(result.success).toBe(true);
    });

    it('should accept all valid fields together', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/project',
        name: 'Project Terminal',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionType: 'user',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject path traversal attempts', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('should reject name exceeding max length', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid session ID format', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: 'invalid; rm -rf /',
      });
      expect(result.success).toBe(false);
    });

    it('should reject session ID with special characters', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: '$(whoami)',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'admin',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-object input', () => {
      const result = terminalStartOptionsSchema.safeParse('string');
      expect(result.success).toBe(false);
    });

    it('should reject null input', () => {
      const result = terminalStartOptionsSchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// PLAIN TERMINAL START OPTIONS SCHEMA TESTS
// ============================================================================

describe('plainTerminalStartOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept valid cwd and name', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({
        cwd: '/home/user',
        name: 'Shell',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject path traversal in cwd', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({
        cwd: '../../../etc',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL INPUT SCHEMA TESTS
// ============================================================================

describe('terminalInputSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid id and data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'ls -la',
      });
      expect(result.success).toBe(true);
    });

    it('should accept zero as valid id', () => {
      const result = terminalInputSchema.safeParse({
        id: 0,
        data: 'echo hello',
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty string data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: '',
      });
      expect(result.success).toBe(true);
    });

    it('should accept data with special characters (terminal handles this)', () => {
      // Note: The schema allows any string because the terminal itself
      // is the execution context - we just validate structure
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'rm -rf / && echo "done"',
      });
      expect(result.success).toBe(true);
    });

    it('should accept multiline data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'line1\nline2\nline3',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject negative id', () => {
      const result = terminalInputSchema.safeParse({
        id: -1,
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer id', () => {
      const result = terminalInputSchema.safeParse({
        id: 1.5,
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject string id', () => {
      const result = terminalInputSchema.safeParse({
        id: '1',
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing id', () => {
      const result = terminalInputSchema.safeParse({
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-string data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 123,
      });
      expect(result.success).toBe(false);
    });

    it('should reject null input', () => {
      const result = terminalInputSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined input', () => {
      const result = terminalInputSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL RESIZE SCHEMA TESTS
// ============================================================================

describe('terminalResizeSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid resize dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 24,
      });
      expect(result.success).toBe(true);
    });

    it('should accept minimum dimensions (1x1)', () => {
      const result = terminalResizeSchema.safeParse({
        id: 0,
        cols: 1,
        rows: 1,
      });
      expect(result.success).toBe(true);
    });

    it('should accept maximum dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 500,
        rows: 200,
      });
      expect(result.success).toBe(true);
    });

    it('should accept large terminal dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 300,
        rows: 100,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject zero cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 0,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject zero rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: -1,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject cols exceeding maximum', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 501,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject rows exceeding maximum', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 201,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80.5,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 24.5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative id', () => {
      const result = terminalResizeSchema.safeParse({
        id: -1,
        cols: 80,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL ID SCHEMA TESTS
// ============================================================================

describe('terminalIdSchema', () => {
  describe('valid inputs', () => {
    it('should accept zero', () => {
      const result = terminalIdSchema.safeParse(0);
      expect(result.success).toBe(true);
    });

    it('should accept positive integers', () => {
      const result = terminalIdSchema.safeParse(42);
      expect(result.success).toBe(true);
    });

    it('should accept large positive integers', () => {
      const result = terminalIdSchema.safeParse(999999);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject negative numbers', () => {
      const result = terminalIdSchema.safeParse(-1);
      expect(result.success).toBe(false);
    });

    it('should reject non-integers', () => {
      const result = terminalIdSchema.safeParse(1.5);
      expect(result.success).toBe(false);
    });

    it('should reject strings', () => {
      const result = terminalIdSchema.safeParse('1');
      expect(result.success).toBe(false);
    });

    it('should reject null', () => {
      const result = terminalIdSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined', () => {
      const result = terminalIdSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should reject objects', () => {
      const result = terminalIdSchema.safeParse({ id: 1 });
      expect(result.success).toBe(false);
    });

    it('should reject arrays', () => {
      const result = terminalIdSchema.safeParse([1]);
      expect(result.success).toBe(false);
    });

    it('should reject NaN', () => {
      const result = terminalIdSchema.safeParse(NaN);
      expect(result.success).toBe(false);
    });

    it('should reject Infinity', () => {
      const result = terminalIdSchema.safeParse(Infinity);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// EDGE CASE TESTS - Security focused
// ============================================================================

describe('Security Edge Cases', () => {
  describe('Command Injection via Session ID', () => {
    const injectionPayloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`id`',
      '$(id)',
      '\n; malicious',
      '\r\n; malicious',
      '${PATH}',
      '> /tmp/pwned',
      '< /etc/shadow',
    ];

    injectionPayloads.forEach((payload) => {
      it(`should reject session ID with injection: ${JSON.stringify(payload)}`, () => {
        const result = terminalStartOptionsSchema.safeParse({
          resumeSessionId: `valid${payload}`,
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Path Traversal Attempts', () => {
    const traversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/home/user/../../../root',
      'C:\\Users\\..\\..\\Windows',
    ];

    traversalPayloads.forEach((payload) => {
      it(`should reject cwd with path traversal: ${payload}`, () => {
        const result = terminalStartOptionsSchema.safeParse({
          cwd: payload,
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should not be affected by __proto__ in input', () => {
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "id": 1, "data": "test"}');
      const result = terminalInputSchema.safeParse(maliciousInput);
      // Should parse without throwing, and result should be clean
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should not be affected by constructor.prototype', () => {
      const maliciousInput = {
        id: 1,
        data: 'test',
        constructor: { prototype: { polluted: true } },
      };
      const result = terminalInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
    });
  });

  describe('Type Coercion Attacks', () => {
    it('should reject array where object expected', () => {
      const result = terminalInputSchema.safeParse([1, 'test']);
      expect(result.success).toBe(false);
    });

    it('should reject nested objects for primitive fields', () => {
      const result = terminalInputSchema.safeParse({
        id: { valueOf: () => 1 },
        data: 'test',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Buffer/Binary Handling', () => {
    it('should reject Buffer objects', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: Buffer.from('test'),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Unicode/Encoding Edge Cases', () => {
    it('should accept unicode in terminal data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'echo "\u0000\u001b[31mred\u001b[0m"',
      });
      expect(result.success).toBe(true);
    });

    it('should accept emoji in terminal name', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'Terminal 1',
      });
      expect(result.success).toBe(true);
    });
  });
});
