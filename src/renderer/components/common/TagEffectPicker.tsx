// ============================================================================
// TAG EFFECT PICKER - Visual effect selector for tag animations
// ============================================================================

import React from 'react';
import clsx from 'clsx';
import type { TagEffect } from '../../../shared/types/index.js';

/**
 * Props for the TagEffectPicker component
 */
interface TagEffectPickerProps {
  /** Currently selected effect (null for no effect) */
  value: TagEffect | null;
  
  /** Callback when effect changes */
  onChange: (effect: TagEffect | null) => void;
  
  /** Color to use in preview tags (default: #3B82F6) */
  previewColor?: string;
}

/**
 * Effect options with labels and descriptions
 */
const EFFECT_OPTIONS: Array<{ 
  value: TagEffect | null;
  label: string; 
  description: string;
}> = [
  { 
    value: null, 
    label: 'None', 
    description: 'No animation effect' 
  },
  { 
    value: 'shimmer', 
    label: 'Shimmer', 
    description: 'Animated shine sweep' 
  },
  { 
    value: 'glow', 
    label: 'Glow', 
    description: 'Pulsing glow effect' 
  },
  { 
    value: 'pulse', 
    label: 'Pulse', 
    description: 'Gentle scale pulse' 
  },
];

/**
 * TagEffectPicker - Visual effect selector for tag animations
 * 
 * Displays a list of available visual effects with live previews,
 * allowing users to select an effect for their tags.
 * 
 * Features:
 * - Live preview of each animation effect
 * - Visual indicator for selected option
 * - Clear descriptions for each effect
 * - Option to select no effect
 * 
 * @example
 * ```tsx
 * <TagEffectPicker
 *   value={tag.effect}
 *   onChange={(effect) => updateTag({ ...tag, effect })}
 *   previewColor={tag.color}
 * />
 * ```
 */
export const TagEffectPicker: React.FC<TagEffectPickerProps> = ({
  value,
  onChange,
  previewColor = '#3B82F6', // Default primary blue
}) => {
  // Convert hex to rgba for styling
  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  return (
    <div className="space-y-2">
      {EFFECT_OPTIONS.map(option => {
        // Get animation class for this effect
        const effectClass = option.value
          ? {
              shimmer: 'animate-shimmer-slide',
              glow: 'animate-glow-pulse',
              pulse: 'animate-pulse',
            }[option.value]
          : '';

        return (
          <button
            key={option.value ?? 'none'}
            onClick={() => onChange(option.value)}
            className={clsx(
              'w-full p-3 rounded-lg border transition-colors text-left',
              'hover:bg-surface-2',
              value === option.value
                ? 'border-accent-primary bg-surface-2'
                : 'border-surface-3'
            )}
            type="button"
            aria-label={`${option.label} effect: ${option.description}`}
            aria-pressed={value === option.value ? 'true' : 'false'}
          >
            <div className="flex items-center justify-between">
              {/* Label and description */}
              <div>
                <div className="font-medium text-text-primary">
                  {option.label}
                </div>
                <div className="text-xs text-text-tertiary">
                  {option.description}
                </div>
              </div>

              {/* Live preview tag */}
              <div
                className={clsx(
                  'px-2 py-1 rounded-full text-xs font-medium',
                  effectClass
                )}
                style={{
                  backgroundColor: hexToRgba(previewColor, 0.2),
                  color: previewColor,
                }}
                aria-hidden="true"
              >
                Preview
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};
