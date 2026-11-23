/**
 * PaymentsEnabledField, the editor for `payments.enabled`.
 *
 * Turning payments on is choosing how purchases run at the same time: the two
 * ways (`payments.confirmEveryPurchase` true or false) are shown with what each
 * means, in the platform's own words (purchaseModeChoices, the terminal programs
 * offer the same list), and "Turn on" is pressed only after one is picked; both
 * settings are written in one update. Nothing is picked in advance, so a
 * first-time enable is always a choice, and a stored choice changes only when a
 * way is picked here. While payments are on the row says which way is in force;
 * turning them off writes `payments.enabled` alone.
 */
import { useState } from 'react';
import { purchaseModeChoices, type PurchaseModeChoice } from '@goodvibes/engine/platform/platform/payments/browser';
import { Button } from '../ui/Button';
import { Radio } from '../ui/Radio';
import { Toggle } from '../ui/Toggle';

export interface PaymentsEnabledFieldProps {
  readonly enabled: boolean;
  /** `payments.confirmEveryPurchase` in force. */
  readonly confirmEveryPurchase: boolean;
  /** `payments.windows.vetoMinutes` in force: the minutes the second way gives. */
  readonly vetoMinutes: number;
  readonly disabled?: boolean;
  readonly onTurnOff: () => void;
  readonly onTurnOn: (confirmEveryPurchase: boolean) => void;
}

export function PaymentsEnabledField({ enabled, confirmEveryPurchase, vetoMinutes, disabled, onTurnOff, onTurnOn }: PaymentsEnabledFieldProps) {
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<PurchaseModeChoice['id'] | null>(null);
  const modes = purchaseModeChoices(vetoMinutes);
  const inForce = modes.find((mode) => mode.confirmEveryPurchase === confirmEveryPurchase);

  if (enabled) {
    return (
      <div className="payments-enabled-field">
        <Toggle className="settings-field-toggle" checked disabled={disabled} aria-label="payments.enabled" onChange={(next) => { if (!next) onTurnOff(); }} />
        {inForce && <p className="payments-enabled-field__mode" role="status">On: {inForce.label}. {inForce.detail}</p>}
      </div>
    );
  }

  if (!choosing) {
    return (
      <div className="payments-enabled-field">
        <Toggle
          className="settings-field-toggle"
          checked={false}
          disabled={disabled}
          aria-label="payments.enabled"
          onChange={(next) => { if (next) { setPicked(null); setChoosing(true); } }}
        />
      </div>
    );
  }

  const chosen = modes.find((mode) => mode.id === picked);
  return (
    <div className="payments-enabled-field payments-enabled-field--choosing" role="group" aria-label="How purchases run">
      <p className="payments-enabled-field__ask">Choose how purchases run before payments are turned on:</p>
      {modes.map((mode) => (
        <Radio key={mode.id} name="payments-purchase-mode" checked={picked === mode.id} disabled={disabled} onChange={() => setPicked(mode.id)}>
          <span className="payments-enabled-field__label">{mode.label}</span>
          <span className="payments-enabled-field__detail">{mode.detail}</span>
        </Radio>
      ))}
      <div className="payments-enabled-field__buttons">
        <Button size="sm" variant="primary" disabled={disabled || !chosen} onClick={() => { if (chosen) { onTurnOn(chosen.confirmEveryPurchase); setChoosing(false); } }}>
          Turn on
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setChoosing(false)}>Cancel</Button>
      </div>
    </div>
  );
}
