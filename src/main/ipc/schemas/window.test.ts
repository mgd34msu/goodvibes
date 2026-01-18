// ============================================================================
// WINDOW SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by window-related IPC handlers
// (clipboard and context menu operations).
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  clipboardWriteSchema,
  contextMenuOptionsSchema,
  terminalContextMenuOptionsSchema,
} from './window.js';

// ============================================================================
// CLIPBOARD WRITE SCHEMA TESTS
// ============================================================================

describe('clipboardWriteSchema', () => {
  describe('valid inputs', () => {
    const validInputs = [
      { value: 'Hello, World!', description: 'simple text' },
      { value: '', description: 'empty string' },
      { value: ' ', description: 'whitespace' },
      { value: 'Line 1\nLine 2\nLine 3', description: 'multiline text' },
      { value: 'Tab\there\ttoo', description: 'text with tabs' },
      { value: 'Unicode: \u0041\u0042\u0043', description: 'unicode text' },
      { value: 'Emoji: test', description: 'emoji' },
      { value: '<script>alert(1)</script>', description: 'HTML (will be pasted as text)' },
      { value: '{"key": "value"}', description: 'JSON string' },
      { value: 'a'.repeat(1000), description: '1KB text' },
      { value: 'x'.repeat(100000), description: '100KB text' },
    ];

    validInputs.forEach(({ value, description }) => {
      it(`accepts ${description}`, () => {
        const result = clipboardWriteSchema.safeParse(value);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(value);
        }
      });
    });
  });

  describe('invalid inputs', () => {
    const invalidInputs = [
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: true, reason: 'boolean' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: Symbol('test'), reason: 'symbol' },
    ];

    invalidInputs.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = clipboardWriteSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('size limits', () => {
    it('accepts text at reasonable size (1MB)', () => {
      const text = 'a'.repeat(1_000_000);
      const result = clipboardWriteSchema.safeParse(text);
      expect(result.success).toBe(true);
    });

    it('accepts text just under 10MB limit', () => {
      const text = 'a'.repeat(9_999_999);
      const result = clipboardWriteSchema.safeParse(text);
      expect(result.success).toBe(true);
    });

    it('rejects text over 10MB limit', () => {
      const text = 'a'.repeat(10_000_001);
      const result = clipboardWriteSchema.safeParse(text);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('10MB');
      }
    });
  });
});

// ============================================================================
// CONTEXT MENU OPTIONS SCHEMA TESTS
// ============================================================================

describe('contextMenuOptionsSchema', () => {
  describe('valid inputs', () => {
    const validInputs = [
      { options: { hasSelection: true, isEditable: true }, description: 'selection in editable' },
      { options: { hasSelection: false, isEditable: true }, description: 'no selection in editable' },
      { options: { hasSelection: true, isEditable: false }, description: 'selection in non-editable' },
      { options: { hasSelection: false, isEditable: false }, description: 'no selection, non-editable' },
      { options: { hasSelection: true, isEditable: true, isTerminal: true }, description: 'terminal context' },
      { options: { hasSelection: false, isEditable: false, isTerminal: false }, description: 'all false' },
      { options: { hasSelection: true, isEditable: false, isTerminal: undefined }, description: 'isTerminal undefined' },
    ];

    validInputs.forEach(({ options, description }) => {
      it(`accepts ${description}`, () => {
        const result = contextMenuOptionsSchema.safeParse(options);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid inputs', () => {
    const invalidInputs = [
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 'string', reason: 'string' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'empty object (missing required fields)' },
      { value: { hasSelection: true }, reason: 'missing isEditable' },
      { value: { isEditable: true }, reason: 'missing hasSelection' },
      { value: { hasSelection: 'true', isEditable: true }, reason: 'hasSelection as string' },
      { value: { hasSelection: true, isEditable: 'true' }, reason: 'isEditable as string' },
      { value: { hasSelection: 1, isEditable: 0 }, reason: 'numbers instead of booleans' },
      { value: [], reason: 'array' },
    ];

    invalidInputs.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = contextMenuOptionsSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('type coercion protection', () => {
    it('rejects truthy non-boolean values for hasSelection', () => {
      const result = contextMenuOptionsSchema.safeParse({
        hasSelection: 'yes',
        isEditable: true,
      });
      expect(result.success).toBe(false);
    });

    it('rejects 0 and 1 for boolean fields', () => {
      const result = contextMenuOptionsSchema.safeParse({
        hasSelection: 1,
        isEditable: 0,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL CONTEXT MENU OPTIONS SCHEMA TESTS
// ============================================================================

describe('terminalContextMenuOptionsSchema', () => {
  describe('valid inputs', () => {
    const validInputs = [
      { options: { hasSelection: true }, description: 'selection only' },
      { options: { hasSelection: false }, description: 'no selection' },
      { options: { hasSelection: true, selectedText: 'copied text' }, description: 'with selected text' },
      { options: { hasSelection: false, selectedText: undefined }, description: 'explicit undefined text' },
      { options: { hasSelection: true, selectedText: '' }, description: 'empty selected text' },
      { options: { hasSelection: true, selectedText: 'Multi\nline\ntext' }, description: 'multiline selected text' },
      { options: { hasSelection: true, selectedText: 'a'.repeat(100000) }, description: '100KB selected text' },
    ];

    validInputs.forEach(({ options, description }) => {
      it(`accepts ${description}`, () => {
        const result = terminalContextMenuOptionsSchema.safeParse(options);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid inputs', () => {
    const invalidInputs = [
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: {}, reason: 'missing hasSelection' },
      { value: { selectedText: 'text' }, reason: 'missing hasSelection with selectedText' },
      { value: { hasSelection: 'true' }, reason: 'hasSelection as string' },
      { value: { hasSelection: 1 }, reason: 'hasSelection as number' },
      { value: { hasSelection: true, selectedText: 123 }, reason: 'selectedText as number' },
      { value: { hasSelection: true, selectedText: {} }, reason: 'selectedText as object' },
      { value: { hasSelection: true, selectedText: [] }, reason: 'selectedText as array' },
    ];

    invalidInputs.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = terminalContextMenuOptionsSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('size limits for selectedText', () => {
    it('accepts text at 100KB limit', () => {
      const text = 'a'.repeat(100_000);
      const result = terminalContextMenuOptionsSchema.safeParse({
        hasSelection: true,
        selectedText: text,
      });
      expect(result.success).toBe(true);
    });

    it('rejects text over 100KB limit', () => {
      const text = 'a'.repeat(100_001);
      const result = terminalContextMenuOptionsSchema.safeParse({
        hasSelection: true,
        selectedText: text,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('100KB');
      }
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('clipboardWriteSchema handles potentially dangerous content', () => {
    const dangerousInputs = [
      '<script>alert(1)</script>',
      'javascript:void(0)',
      'data:text/html,<script>alert(1)</script>',
      '"; DROP TABLE users; --',
      '${process.env.SECRET}',
      '$(cat /etc/passwd)',
      '`whoami`',
      '\x00\x01\x02\x03', // null bytes and control characters
      '\u0000null', // unicode null
      '\uFEFF\u200B', // BOM and zero-width space
    ];

    dangerousInputs.forEach((input) => {
      it(`accepts but does not execute: "${input.substring(0, 30)}..."`, () => {
        // Clipboard should accept any text - it's just text storage
        // The schema validates structure, not content safety
        const result = clipboardWriteSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          // Data should be exactly preserved, not sanitized
          expect(result.data).toBe(input);
        }
      });
    });
  });

  describe('contextMenuOptionsSchema rejects prototype pollution', () => {
    const pollutionAttempts = [
      { __proto__: { isAdmin: true }, hasSelection: true, isEditable: true },
      { constructor: { prototype: {} }, hasSelection: true, isEditable: true },
      { prototype: {}, hasSelection: true, isEditable: true },
    ];

    pollutionAttempts.forEach((input, index) => {
      it(`safely handles prototype pollution attempt ${index + 1}`, () => {
        const result = contextMenuOptionsSchema.safeParse(input);
        // Zod should strip extra properties or handle safely
        if (result.success) {
          // Verify no pollution of prototype
          expect(Object.prototype.hasOwnProperty.call(result.data, '__proto__')).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(result.data, 'constructor')).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(result.data, 'prototype')).toBe(false);
        }
      });
    });
  });

  describe('terminalContextMenuOptionsSchema size limits prevent DoS', () => {
    it('rejects extremely large selectedText', () => {
      const hugeText = 'x'.repeat(200_000); // 200KB
      const result = terminalContextMenuOptionsSchema.safeParse({
        hasSelection: true,
        selectedText: hugeText,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// EDGE CASES AND BOUNDARY CONDITIONS
// ============================================================================

describe('Edge cases', () => {
  describe('clipboardWriteSchema edge cases', () => {
    it('handles unicode boundary conditions', () => {
      // Surrogate pairs
      const surrogatePair = '\uD83D\uDE00'; // Emoji
      const result = clipboardWriteSchema.safeParse(surrogatePair);
      expect(result.success).toBe(true);
    });

    it('handles very long single line', () => {
      const longLine = 'x'.repeat(1_000_000);
      const result = clipboardWriteSchema.safeParse(longLine);
      expect(result.success).toBe(true);
    });

    it('handles many short lines', () => {
      const manyLines = Array(10000).fill('short line').join('\n');
      const result = clipboardWriteSchema.safeParse(manyLines);
      expect(result.success).toBe(true);
    });
  });

  describe('contextMenuOptionsSchema edge cases', () => {
    it('preserves extra properties by stripping them', () => {
      const input = {
        hasSelection: true,
        isEditable: true,
        extraProperty: 'should be ignored',
      };
      const result = contextMenuOptionsSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Zod by default strips extra properties
        expect(Object.keys(result.data)).not.toContain('extraProperty');
      }
    });
  });

  describe('terminalContextMenuOptionsSchema edge cases', () => {
    it('handles selectedText with only whitespace', () => {
      const result = terminalContextMenuOptionsSchema.safeParse({
        hasSelection: true,
        selectedText: '   \n\t\r  ',
      });
      expect(result.success).toBe(true);
    });

    it('handles selectedText with special terminal characters', () => {
      // ANSI escape codes that might be in terminal output
      const ansiText = '\x1b[31mRed Text\x1b[0m';
      const result = terminalContextMenuOptionsSchema.safeParse({
        hasSelection: true,
        selectedText: ansiText,
      });
      expect(result.success).toBe(true);
    });
  });
});
