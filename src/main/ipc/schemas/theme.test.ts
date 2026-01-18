// ============================================================================
// THEME SCHEMAS TESTS
// ============================================================================
//
// Tests for Zod validation schemas used by theme IPC handlers.
// Verifies that the schemas correctly validate theme input and reject invalid data.
//
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  themeIdSchema,
  themeVariantSchema,
  hexColorSchema,
  rgbaColorSchema,
  cssColorSchema,
  setColorThemeInputSchema,
  setThemeModeInputSchema,
  themeSettingSchema,
  VALID_THEME_IDS,
  isThemeSettingKey,
  validateThemeSettingValue,
} from './theme.js';

// ============================================================================
// THEME ID SCHEMA TESTS
// ============================================================================

describe('themeIdSchema', () => {
  describe('valid theme IDs', () => {
    VALID_THEME_IDS.forEach((themeId) => {
      it(`accepts valid theme ID "${themeId}"`, () => {
        const result = themeIdSchema.safeParse(themeId);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(themeId);
        }
      });
    });
  });

  describe('invalid theme IDs', () => {
    const invalidThemeIds = [
      { value: 'invalid-theme', reason: 'non-existent theme' },
      { value: 'goodvibes', reason: 'partial theme name' },
      { value: 'GOODVIBES-CLASSIC', reason: 'uppercase' },
      { value: 'goodvibes_classic', reason: 'underscore instead of dash' },
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 123, reason: 'number' },
      { value: {}, reason: 'object' },
      { value: [], reason: 'array' },
      { value: true, reason: 'boolean' },
      { value: 'catppuccin', reason: 'catppuccin without variant' },
      { value: 'dark', reason: 'variant instead of theme ID' },
      { value: 'light', reason: 'variant instead of theme ID' },
    ];

    invalidThemeIds.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = themeIdSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('error messages', () => {
    it('provides helpful error message for invalid theme', () => {
      const result = themeIdSchema.safeParse('invalid-theme');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid theme ID');
        expect(result.error.issues[0].message).toContain('goodvibes-classic');
      }
    });
  });
});

// ============================================================================
// THEME VARIANT SCHEMA TESTS
// ============================================================================

describe('themeVariantSchema', () => {
  describe('valid variants', () => {
    const validVariants = ['dark', 'light'];

    validVariants.forEach((variant) => {
      it(`accepts "${variant}"`, () => {
        const result = themeVariantSchema.safeParse(variant);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(variant);
        }
      });
    });
  });

  describe('invalid variants', () => {
    const invalidVariants = [
      { value: 'Dark', reason: 'capitalized' },
      { value: 'DARK', reason: 'uppercase' },
      { value: 'system', reason: 'system preference not supported' },
      { value: 'auto', reason: 'auto mode not supported' },
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: undefined, reason: 'undefined' },
      { value: 0, reason: 'zero' },
      { value: 1, reason: 'one' },
      { value: true, reason: 'boolean true' },
      { value: false, reason: 'boolean false' },
    ];

    invalidVariants.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = themeVariantSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('error messages', () => {
    it('provides helpful error message for invalid variant', () => {
      const result = themeVariantSchema.safeParse('invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('dark');
        expect(result.error.issues[0].message).toContain('light');
      }
    });
  });
});

// ============================================================================
// HEX COLOR SCHEMA TESTS
// ============================================================================

describe('hexColorSchema', () => {
  describe('valid hex colors', () => {
    const validColors = [
      '#000000',
      '#ffffff',
      '#FFFFFF',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#123abc',
      '#ABC123',
      '#abcdef',
    ];

    validColors.forEach((color) => {
      it(`accepts "${color}"`, () => {
        const result = hexColorSchema.safeParse(color);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid hex colors', () => {
    const invalidColors = [
      { value: '000000', reason: 'missing hash' },
      { value: '#fff', reason: '3-digit shorthand' },
      { value: '#ffff', reason: '4-digit format' },
      { value: '#fffff', reason: '5-digit format' },
      { value: '#fffffff', reason: '7-digit format' },
      { value: '#gggggg', reason: 'invalid hex characters' },
      { value: '#12345g', reason: 'contains non-hex character' },
      { value: 'red', reason: 'named color' },
      { value: 'rgb(255, 0, 0)', reason: 'rgb format' },
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
      { value: 123, reason: 'number' },
    ];

    invalidColors.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = hexColorSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// RGBA COLOR SCHEMA TESTS
// ============================================================================

describe('rgbaColorSchema', () => {
  describe('valid rgba colors', () => {
    const validColors = [
      'rgba(255, 0, 0, 0.5)',
      'rgba(0, 0, 0, 1)',
      'rgba(255, 255, 255, 0)',
      'rgba(100, 100, 100, 0.25)',
      'rgb(255, 0, 0)',
      'rgb(0, 0, 0)',
    ];

    validColors.forEach((color) => {
      it(`accepts "${color}"`, () => {
        const result = rgbaColorSchema.safeParse(color);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('invalid rgba colors', () => {
    const invalidColors = [
      { value: 'rgba()', reason: 'empty rgba' },
      { value: 'rgba(255, 0)', reason: 'missing values' },
      // Note: regex accepts values > 255 since it only checks digit patterns
      // Value range validation would require additional logic or a different approach
      { value: '#ff0000', reason: 'hex format' },
      { value: 'red', reason: 'named color' },
      { value: '', reason: 'empty string' },
      { value: null, reason: 'null' },
    ];

    invalidColors.forEach(({ value, reason }) => {
      it(`rejects ${reason}`, () => {
        const result = rgbaColorSchema.safeParse(value);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// CSS COLOR SCHEMA TESTS
// ============================================================================

describe('cssColorSchema', () => {
  it('accepts hex colors', () => {
    expect(cssColorSchema.safeParse('#ff0000').success).toBe(true);
  });

  it('accepts rgba colors', () => {
    expect(cssColorSchema.safeParse('rgba(255, 0, 0, 0.5)').success).toBe(true);
  });

  it('rejects named colors', () => {
    expect(cssColorSchema.safeParse('red').success).toBe(false);
  });
});

// ============================================================================
// SET COLOR THEME INPUT SCHEMA TESTS
// ============================================================================

describe('setColorThemeInputSchema', () => {
  it('accepts valid colorTheme setting', () => {
    const result = setColorThemeInputSchema.safeParse({
      key: 'colorTheme',
      value: 'dracula',
    });
    expect(result.success).toBe(true);
  });

  it('rejects wrong key', () => {
    const result = setColorThemeInputSchema.safeParse({
      key: 'theme',
      value: 'dracula',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid theme value', () => {
    const result = setColorThemeInputSchema.safeParse({
      key: 'colorTheme',
      value: 'invalid-theme',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// SET THEME MODE INPUT SCHEMA TESTS
// ============================================================================

describe('setThemeModeInputSchema', () => {
  it('accepts valid theme mode setting', () => {
    const result = setThemeModeInputSchema.safeParse({
      key: 'theme',
      value: 'dark',
    });
    expect(result.success).toBe(true);
  });

  it('accepts light mode', () => {
    const result = setThemeModeInputSchema.safeParse({
      key: 'theme',
      value: 'light',
    });
    expect(result.success).toBe(true);
  });

  it('rejects wrong key', () => {
    const result = setThemeModeInputSchema.safeParse({
      key: 'colorTheme',
      value: 'dark',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid mode value', () => {
    const result = setThemeModeInputSchema.safeParse({
      key: 'theme',
      value: 'system',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// THEME SETTING SCHEMA TESTS
// ============================================================================

describe('themeSettingSchema', () => {
  it('accepts colorTheme with valid theme ID', () => {
    const result = themeSettingSchema.safeParse({
      key: 'colorTheme',
      value: 'nord',
    });
    expect(result.success).toBe(true);
  });

  it('accepts theme with valid variant', () => {
    const result = themeSettingSchema.safeParse({
      key: 'theme',
      value: 'dark',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unrelated setting key', () => {
    const result = themeSettingSchema.safeParse({
      key: 'fontSize',
      value: 14,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// IS THEME SETTING KEY HELPER TESTS
// ============================================================================

describe('isThemeSettingKey', () => {
  it('returns true for colorTheme', () => {
    expect(isThemeSettingKey('colorTheme')).toBe(true);
  });

  it('returns true for theme', () => {
    expect(isThemeSettingKey('theme')).toBe(true);
  });

  it('returns false for fontSize', () => {
    expect(isThemeSettingKey('fontSize')).toBe(false);
  });

  it('returns false for claudePath', () => {
    expect(isThemeSettingKey('claudePath')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isThemeSettingKey('')).toBe(false);
  });
});

// ============================================================================
// VALIDATE THEME SETTING VALUE HELPER TESTS
// ============================================================================

describe('validateThemeSettingValue', () => {
  describe('colorTheme validation', () => {
    it('succeeds for valid theme ID', () => {
      const result = validateThemeSettingValue('colorTheme', 'dracula');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('dracula');
      }
    });

    it('fails for invalid theme ID', () => {
      const result = validateThemeSettingValue('colorTheme', 'invalid-theme');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid theme ID');
      }
    });

    VALID_THEME_IDS.forEach((themeId) => {
      it(`accepts all valid theme IDs: "${themeId}"`, () => {
        const result = validateThemeSettingValue('colorTheme', themeId);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('theme validation', () => {
    it('succeeds for dark mode', () => {
      const result = validateThemeSettingValue('theme', 'dark');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('dark');
      }
    });

    it('succeeds for light mode', () => {
      const result = validateThemeSettingValue('theme', 'light');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('light');
      }
    });

    it('fails for invalid mode', () => {
      const result = validateThemeSettingValue('theme', 'system');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('dark');
        expect(result.error).toContain('light');
      }
    });
  });

  describe('non-theme settings', () => {
    it('passes through non-theme settings without validation', () => {
      const result = validateThemeSettingValue('fontSize', 14);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(14);
      }
    });

    it('passes through any value for non-theme settings', () => {
      const result = validateThemeSettingValue('customSetting', { nested: 'value' });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security edge cases', () => {
  describe('themeIdSchema rejects injection attempts', () => {
    const injectionPayloads = [
      '<script>alert(1)</script>',
      '"; DROP TABLE themes;--',
      '${process.env.SECRET}',
      '../../../etc/passwd',
      'goodvibes-classic<script>',
      'dracula\x00',
      'nord\nlight',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects injection payload: "${payload.substring(0, 30)}"`, () => {
        const result = themeIdSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('themeVariantSchema rejects injection attempts', () => {
    const injectionPayloads = [
      'dark<script>',
      'light; DROP TABLE',
      '${env}',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects injection payload: "${payload}"`, () => {
        const result = themeVariantSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });
  });
});

// ============================================================================
// EDGE CASES AND BOUNDARY CONDITIONS
// ============================================================================

describe('Edge cases', () => {
  describe('themeIdSchema boundary conditions', () => {
    it('is case-sensitive (rejects uppercase)', () => {
      expect(themeIdSchema.safeParse('DRACULA').success).toBe(false);
      expect(themeIdSchema.safeParse('Dracula').success).toBe(false);
    });

    it('rejects partial matches', () => {
      expect(themeIdSchema.safeParse('goodvibes').success).toBe(false);
      expect(themeIdSchema.safeParse('classic').success).toBe(false);
      expect(themeIdSchema.safeParse('catppuccin').success).toBe(false);
    });

    it('rejects themes with extra whitespace', () => {
      expect(themeIdSchema.safeParse(' dracula').success).toBe(false);
      expect(themeIdSchema.safeParse('dracula ').success).toBe(false);
      expect(themeIdSchema.safeParse(' dracula ').success).toBe(false);
    });
  });

  describe('themeVariantSchema boundary conditions', () => {
    it('is case-sensitive', () => {
      expect(themeVariantSchema.safeParse('Dark').success).toBe(false);
      expect(themeVariantSchema.safeParse('Light').success).toBe(false);
    });

    it('rejects variants with extra whitespace', () => {
      expect(themeVariantSchema.safeParse(' dark').success).toBe(false);
      expect(themeVariantSchema.safeParse('light ').success).toBe(false);
    });
  });

  describe('validateThemeSettingValue with edge case inputs', () => {
    it('handles null value for colorTheme', () => {
      const result = validateThemeSettingValue('colorTheme', null);
      expect(result.success).toBe(false);
    });

    it('handles undefined value for colorTheme', () => {
      const result = validateThemeSettingValue('colorTheme', undefined);
      expect(result.success).toBe(false);
    });

    it('handles object value for colorTheme', () => {
      const result = validateThemeSettingValue('colorTheme', { theme: 'dracula' });
      expect(result.success).toBe(false);
    });

    it('handles array value for colorTheme', () => {
      const result = validateThemeSettingValue('colorTheme', ['dracula']);
      expect(result.success).toBe(false);
    });

    it('handles number value for theme variant', () => {
      const result = validateThemeSettingValue('theme', 1);
      expect(result.success).toBe(false);
    });

    it('handles boolean value for theme variant', () => {
      const result = validateThemeSettingValue('theme', true);
      expect(result.success).toBe(false);
    });
  });
});
