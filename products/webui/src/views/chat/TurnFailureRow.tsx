/**
 * A reply that failed or was refused, as a row in the conversation (ux A5.1,
 * web): `✕` and the headline ("The model didn't answer."), one dim line with
 * the cause and what changed ("OpenAI returned an error (500) three times.
 * Nothing was changed."), then the next steps as buttons (Try again, Use
 * another model, Details, or Choose a model / Sign in again in Settings for a
 * refusal, which opens Models and providers, where the row signs in),
 * and the tip "name a backup model once" only when no fallback order is set.
 * The prompt above it stays as it was typed.
 *
 * Every word is the failure reading's (platform core/turn-failure.ts, the one
 * the terminal programs draw their row from). The reading rides the stored
 * reply, so the row is the same after a reload. A reply stored before the
 * reading existed carries only its reason text, which the same reader words.
 * Only the newest failed reply keeps its buttons; older rows stay as rows.
 */
import { useState } from 'react';
import {
  readTurnFailure,
  storedTurnFailure,
  type TurnFailureAction,
  type TurnFailureReading,
} from '@goodvibes/engine/platform/platform/core/turn-failure';
import { Button } from '../../components/ui/Button';
import { openSettingsSection } from '../personal/openSettings';
import type { ChatMessage } from './types';

/** The failure reading a failed reply carries, or one read from its reason text. */
export function failureReadingOf(message: ChatMessage, id: string): TurnFailureReading {
  const stored = storedTurnFailure(message.failure) ?? storedTurnFailure(message.failureReason);
  if (stored) return stored;
  const reason = typeof message.failureReason === 'string' ? message.failureReason.trim() : '';
  return readTurnFailure({ turnId: id, ...(reason ? { error: reason } : {}), stopReason: 'failed' });
}

/** The web's button words for a next step ("try again" → "Try again"). */
function buttonLabel(action: TurnFailureAction, label: string): string {
  if (action === 'details') return 'Details';
  // The sign-in is made in Models and providers, from the provider's own row.
  if (action === 'sign-in') return 'Sign in again in Settings';
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

export interface TurnFailureRowProps {
  reading: TurnFailureReading;
  /** Only the newest failed reply offers its next steps. */
  latest: boolean;
  onRetry: () => void;
  /** Open the model menu; choosing a model tries the same prompt again with it. */
  onOtherModel: () => void;
}

export function TurnFailureRow({ reading, latest, onRetry, onOtherModel }: TurnFailureRowProps) {
  const [showDetails, setShowDetails] = useState(false);
  const line = [reading.cause, reading.changed.text].filter((part) => part.length > 0).join(' ');
  const run = (action: TurnFailureAction) => {
    switch (action) {
      case 'retry': onRetry(); return;
      case 'other-model':
      case 'choose-model': onOtherModel(); return;
      case 'details': setShowDetails((open) => !open); return;
      case 'sign-in': openSettingsSection('models'); return;
      case 'start-daemon': return;
    }
  };
  // Starting the service is a terminal step; a page served by it never needs it.
  const buttons = reading.next.filter((step) => step.action !== 'start-daemon');
  return (
    <div className="turn-failure" role="note" aria-label={reading.headline}>
      <p className="turn-failure__headline">
        <span className="turn-failure__mark" aria-hidden="true">✕</span> {reading.headline}
      </p>
      {line && <p className="turn-failure__cause">{line}</p>}
      {showDetails && reading.details.length > 0 && (
        <dl className="turn-failure__details">
          {reading.details.map((row, index) => (
            <div key={`${row.label}-${index}`} className="turn-failure__detail">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {latest && buttons.length > 0 && (
        <div className="turn-failure__actions">
          {buttons.map((step, index) => (
            <Button
              key={step.action}
              size="sm"
              variant={index === 0 ? 'primary' : 'secondary'}
              aria-expanded={step.action === 'details' ? showDetails : undefined}
              onClick={() => run(step.action)}
            >
              {buttonLabel(step.action, step.label)}
            </Button>
          ))}
        </div>
      )}
      {!latest && reading.details.length > 0 && (
        <button type="button" className="turn-failure__link" aria-expanded={showDetails} onClick={() => setShowDetails((open) => !open)}>Details</button>
      )}
      {reading.tip && (
        <p className="turn-failure__tip">
          {reading.tip.text}{' '}
          <button type="button" className="turn-failure__link" onClick={() => openSettingsSection('models')}>Choose a backup model</button>
        </p>
      )}
    </div>
  );
}
