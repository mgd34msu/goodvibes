// ============================================================================
// TAG COLOR PICKER - Color palette selector for tag customization
// ============================================================================

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';

// Predefined color palette - 18 colors in a visually balanced order
const TAG_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#22C55E',
  '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1',
  '#8B5CF6', '#A855F7', '#D946EF', '#EC4899', '#F43F5E', '#6B7280',
];

export interface TagColorPickerProps {
  /** Current hex color value */
  value?: string;
  /** Callback when color changes */
  onChange: (color: string) => void;
  /** Show custom hex input field */
  showCustomInput?: boolean;
}

/**
 * TagColorPicker - Color palette selector for tag customization
 *
 * Features:
 * - 18 predefined colors in a 6x3 grid layout
 * - Visual selection indicator (checkmark)
 * - Hover effects with scale animation
 * - Optional custom hex color input with validation
 * - Live preview of custom colors
 */
export function TagColorPicker({
  value,
  onChange,
  showCustomInput = true,
}: TagColorPickerProps) {
  const [customColor, setCustomColor] = useState(value || '');

  /**
   * Validates hex color format (#RRGGBB)
   */
  const isValidHex = (color: string): boolean => {
    return /^#[0-9A-Fa-f]{6}$/.test(color);
  };

  /**
   * Handle custom color input blur - apply if valid
   */
  const handleCustomColorBlur = () => {
    if (isValidHex(customColor)) {
      onChange(customColor.toUpperCase());
    }
  };

  /**
   * Handle custom color input change
   */
  const handleCustomColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    setCustomColor(input);
  };

  /**
   * Handle preset color selection
   */
  const handleColorSelect = (color: string) => {
    onChange(color);
    setCustomColor(color);
  };

  return (
    <div className="space-y-3">
      {/* Predefined color palette - 6x3 grid */}
      <div className="grid grid-cols-6 gap-2">
        {TAG_COLORS.map((color) => {
          const isSelected = value?.toUpperCase() === color.toUpperCase();
          return (
            <button
              key={color}
              type="button"
              onClick={() => handleColorSelect(color)}
              className={clsx(
                'w-8 h-8 rounded-full transition-all',
                'hover:scale-110 hover:shadow-md',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'focus-visible:ring-white/50 focus-visible:ring-offset-surface-800',
                isSelected && 'ring-2 ring-offset-2 ring-white/50 ring-offset-surface-800',
                'relative flex items-center justify-center'
              )}
              style={{ backgroundColor: color }}
              aria-label={`Select color ${color}`}
              aria-pressed={isSelected}
            >
              {/* Checkmark indicator for selected color */}
              {isSelected && (
                <Check
                  className="w-4 h-4 text-white drop-shadow-md"
                  strokeWidth={3}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Custom hex input */}
      {showCustomInput && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={customColor}
            onChange={handleCustomColorChange}
            onBlur={handleCustomColorBlur}
            placeholder="#RRGGBB"
            className={clsx(
              'flex-1 px-3 py-1.5 rounded text-sm font-mono',
              'bg-surface-700 text-surface-200 border border-surface-600',
              'placeholder:text-surface-500',
              'focus:outline-none focus:ring-2 focus:ring-primary-500',
              'transition-colors',
              !isValidHex(customColor) && customColor && 'border-red-500'
            )}
            maxLength={7}
            aria-label="Custom hex color"
            aria-invalid={!isValidHex(customColor) && customColor !== ''}
          />
          {/* Color preview */}
          <div
            className={clsx(
              'w-8 h-8 rounded-full border-2',
              isValidHex(customColor)
                ? 'border-surface-600'
                : 'border-surface-700 bg-surface-800'
            )}
            style={{
              backgroundColor: isValidHex(customColor) ? customColor : '#808080',
            }}
            aria-label="Color preview"
          />
        </div>
      )}
    </div>
  );
}

// Export the predefined colors for use in other components
export { TAG_COLORS };
