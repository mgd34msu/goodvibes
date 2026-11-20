/**
 * CvvHandlingField, the typed editor for `payments.cvvHandling`.
 *
 * An ordinary enum select ('stored' | 'prompt'), with one addition: while 'prompt'
 * is the stored mode, or is being saved, it shows CVV_PROMPT_TRADEOFF_WARNING, the
 * platform's own wording, imported directly from
 * `@goodvibes/engine/platform/platform/payments/browser` (that subpath has no node-only
 * dependencies, so it is safe to import at runtime, unlike `platform/config`,
 * which generate-config-schema.ts snapshots at build time instead). Selecting
 * 'stored' shows no warning: 'stored' is the owner's settled default, not
 * something this surface argues against.
 */
import { useState } from 'react';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes/engine/platform/platform/payments/browser';
import { Select } from '../ui/Select';

export interface CvvHandlingFieldProps {
  readonly value: string;
  readonly enumValues: readonly string[];
  readonly disabled?: boolean;
  readonly onCommit: (value: string) => void;
}

export function CvvHandlingField({ value, enumValues, disabled, onCommit }: CvvHandlingFieldProps) {
  // The mode the operator just picked. It only counts while the write is in flight
  // (the parent disables the field then); once the write settles the stored `value`
  // decides, so a refused or failed commit leaves no warning about a mode that is not active.
  const [picked, setPicked] = useState<string | null>(null);
  const showPromptWarning = value === 'prompt' || (disabled === true && picked === 'prompt');

  function handleChange(next: string): void {
    setPicked(next);
    onCommit(next);
  }

  return (
    <div className="cvv-handling-field" data-testid="cvv-handling-field">
      <Select
        className="settings-field-select"
        aria-label="payments.cvvHandling"
        value={value}
        disabled={disabled}
        placement="bottom-end"
        options={[
          ...(enumValues.includes(value) ? [] : [{ value, label: value || '(unset)' }]),
          ...enumValues.map((opt) => ({ value: opt, label: opt })),
        ]}
        onChange={handleChange}
      />
      {showPromptWarning && (
        <div className="banner warning cvv-prompt-warning" role="alert" data-testid="cvv-prompt-warning">
          {CVV_PROMPT_TRADEOFF_WARNING}
        </div>
      )}
    </div>
  );
}
