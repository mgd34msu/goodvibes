/**
 * What is set up and what is left, at the top of Settings > General: one row per
 * step, each with its state in words ("Done", "Recommended", "Optional", "Needs
 * HTTPS"), the one action that does it, and "Skip for now" on a step not done.
 * The head counts them ("3 of 5 set up"). The account menu reminds while a
 * recommended step is neither done nor skipped (useSetupChecklist().left).
 *
 * Every state is read from what the page already reads with the same query
 * keys (providers, the current model, the mode in force, paired devices, this
 * browser's push registration), so the checklist adds no request of its own
 * beyond those reads. Skipping is kept in this browser (lib/ui-preferences).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { providerOptionsFromResponse } from '../../lib/provider-models';
import { deriveProviderStatus } from '../../lib/provider-status';
import { useDaemonModeInForce } from '../../lib/mode-in-force';
import { detectPushSupport } from '../../lib/push/push-support';
import { readPushRegistrationState } from '../../lib/push/push-client';
import { useWebUiPreferences } from '../../lib/ui-preferences';
import { asRecord, firstString, readPath } from '../../lib/object';
import { Button } from '../ui/Button';
import { Row, RowList } from '../ui/Row';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';

export type SetupStepState = 'done' | 'recommended' | 'optional' | 'blocked';

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  /** What it gives, or what is wrong, in one sentence. */
  readonly detail: string;
  readonly state: SetupStepState;
  /** The settings section that does it. */
  readonly section: string;
  readonly action: string;
}

/**
 * The steps, read from the page's own queries; `left` counts the recommended ones
 * neither done nor skipped. `withOptional` false (the account menu's reminder)
 * reads only what the recommended steps need, which the shell already reads.
 */
export function useSetupChecklist(withOptional = true): { readonly steps: readonly SetupStep[]; readonly done: number; readonly left: number; readonly skipped: readonly string[] } {
  const [preferences] = useWebUiPreferences();
  const providers = useQuery({ queryKey: queryKeys.providers, queryFn: () => platformClient.operator.providers.list() });
  const current = useQuery({ queryKey: ['models', 'current'], queryFn: () => platformClient.operator.models.current.get() });
  const mode = useDaemonModeInForce();
  const tokens = useQuery({ queryKey: queryKeys.pairingTokens, queryFn: () => platformClient.operator.pairing.tokens.list(), enabled: withOptional, retry: false });
  const [support] = useState(() => detectPushSupport());
  const push = useQuery({ queryKey: ['push', 'registration'], queryFn: readPushRegistrationState, enabled: withOptional && support === 'ok', retry: false });

  const signedIn = providerOptionsFromResponse(providers.data).some((option) => {
    const status = deriveProviderStatus(option.value);
    return status.configured && status.freshness === 'healthy';
  });
  const model = firstString(asRecord(readPath(current.data, ['model'])), ['registryKey', 'id']);
  const words = mode.data?.words;
  const paired = (tokens.data?.tokens.length ?? 0) > 0;
  const notified = push.data?.browserSubscribed === true && push.data.registered !== null;

  const steps: SetupStep[] = [
    {
      id: 'provider', title: 'Connect a model provider', section: 'models', action: 'Open Models and providers',
      state: signedIn ? 'done' : 'recommended',
      detail: signedIn ? 'A provider is signed in and answering.' : 'GoodVibes needs one signed-in provider to answer you.',
    },
    {
      id: 'model', title: 'Choose the model new chats use', section: 'models', action: 'Open Models and providers',
      state: model ? 'done' : 'recommended',
      detail: model ? `New chats use ${model}.` : 'No model is set for new chats yet.',
    },
    {
      id: 'permissions', title: 'Decide when GoodVibes asks you', section: 'permissions', action: 'Open Permissions',
      state: words && words.inForce === undefined ? 'done' : 'recommended',
      detail: words ? (words.inForce === undefined ? `${words.chosen}.` : words.sentence) : 'Read from the daemon when it answers.',
    },
    {
      id: 'notifications', title: 'Get notified on this device', section: 'notifications', action: 'Open Notifications',
      state: support !== 'ok' ? 'blocked' : notified ? 'done' : 'optional',
      detail: support === 'insecure-context'
        ? 'Notifications need this page over HTTPS (for example through Tailscale).'
        : support === 'unsupported' ? 'This browser cannot receive notifications from a page.'
          : notified ? 'This browser gets a notice when something waits for you.' : 'A notice when something waits for you, even with this page closed.',
    },
    {
      id: 'device', title: 'Pair a phone or another browser', section: 'devices', action: 'Open Devices and pairing',
      state: paired ? 'done' : 'optional',
      detail: paired ? 'A device signs in with its own code.' : 'Answer GoodVibes from your phone.',
    },
  ];
  const skipped = preferences.setupSkipped;
  const done = steps.filter((step) => step.state === 'done').length;
  // A step not read yet is not counted as left: the reminder never shows on a guess.
  const read = (id: string) => id === 'provider' ? providers.isSuccess : id === 'model' ? current.isSuccess : id === 'permissions' ? words !== undefined : true;
  const left = steps.filter((step) => step.state === 'recommended' && read(step.id) && !skipped.includes(step.id)).length;
  return { steps, done, left, skipped };
}

const STATE_WORDS: Record<SetupStepState, string> = { done: 'Done', recommended: 'Recommended', optional: 'Optional', blocked: 'Not on this page' };
const STATE_TONE = { done: 'ok', recommended: 'warn', optional: 'idle', blocked: 'idle' } as const;

export function SetupChecklist({ onOpenSection }: { onOpenSection: (section: string) => void }) {
  const { steps, done, skipped } = useSetupChecklist();
  const [preferences, setPreference] = useWebUiPreferences();
  const skip = (id: string, on: boolean) => {
    const rest = preferences.setupSkipped.filter((entry) => entry !== id);
    setPreference('setupSkipped', on ? [...rest, id] : rest);
  };
  return (
    <SettingsBlock title="Setting up" description={`${String(done)} of ${String(steps.length)} set up.`} testId="setup-checklist">
      <RowList aria-label="Setup steps">
        {steps.map((step) => {
          const isSkipped = step.state !== 'done' && skipped.includes(step.id);
          return (
            <Row
              key={step.id}
              className="settings-setup-row"
              leading={<StatusDot tone={STATE_TONE[step.state]} />}
              title={step.title}
              meta={`${isSkipped ? 'Skipped for now' : STATE_WORDS[step.state]} · ${step.detail}`}
              trailing={step.state === 'done' ? undefined : (
                <span className="settings-setup-row__actions">
                  {step.state !== 'blocked' && (
                    <Button size="sm" variant="secondary" onClick={() => onOpenSection(step.section)}>{step.action}</Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => skip(step.id, !isSkipped)}>{isSkipped ? 'Show again' : 'Skip for now'}</Button>
                </span>
              )}
            />
          );
        })}
      </RowList>
    </SettingsBlock>
  );
}
