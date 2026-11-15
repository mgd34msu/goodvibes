/**
 * PairingHandoffOffers, completes a pairing hand-off bundle
 * (platform 1.8.0's pairing.handoff.create/complete): renders each offer this link
 * carried (notifications, relay, passkey), each independently declinable, then
 * drives pairing.handoff.complete and renders the honest per-offer outcome,
 * completed / declined / unavailable / failed, never silently half-applied.
 *
 * Client-side gathering happens BEFORE the daemon call, per accepted offer:
 *   - notifications: the real browser ceremony (permission + VAPID fetch +
 *     PushManager subscribe, ensureBrowserPushSubscription, the same steps
 *     NotificationSettings' toggle runs) produces the endpoint/keys the daemon
 *     needs to register.
 *   - passkey: the real WebAuthn registration ceremony (registerPasskey)
 *     produces the credentialId/publicKeyCose the daemon needs to verify.
 *   - relay: no client-side gathering, accepting sends `relay: true`, an
 *     acknowledgement only (see the platform's pairing-handoff.ts route comment).
 *
 * A ceremony that fails locally (permission denied, no authenticator, browser
 * unsupported, user cancel) is NEVER silently downgraded to "declined", that
 * would misrepresent an attempt as a choice never made. It renders as `failed`
 * with the real client-side reason, and that offer is simply never sent to the
 * daemon (there is nothing valid to send). An offer the operator genuinely
 * left unchecked IS sent as declined (or just omitted, which the daemon treats
 * identically), the two cases read differently in the result list on purpose.
 *
 * A failed offer can be tried again from the result list. A ceremony that already
 * produced its push subscription or passkey is resent as it was, so a retry after a
 * failed daemon request never leaves a second, unrecorded passkey on the device.
 * A passkey the daemon recorded is remembered on this device as an id hint only;
 * the daemon's list stays the record of what is registered.
 */
import { useRef, useState } from 'react';
import { BellRing, KeyRound, Radio } from 'lucide-react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { StatusDot, type StatusTone } from '../ui/StatusDot';
import { client as platformClient } from '../../lib/goodvibes';
import type {
  PairingHandoffCompleteNotificationsAccept,
  PairingHandoffCompletePasskeyAccept,
  PairingHandoffOutcome,
} from '../../lib/goodvibes';
import type { PairingOfferKind } from '../../lib/pairing';
import { describePushSubscribeError, ensureBrowserPushSubscription, ensureDeviceId } from '../../lib/push/push-client';
import { describeStepUpError, registerPasskey, setRegisteredCredential, stepUpAvailability } from '../../lib/stepup';
import { formatError } from '../../lib/errors';
import '../../styles/components/pairing-handoff.css';

export interface PairingHandoffOffersProps {
  offers: readonly PairingOfferKind[];
  onDone: () => void;
  /**
   * The daemon's one honest plain-http-on-LAN notice line (usePairingHandoff's
   * postureNotice), shown once at the top of this modal, never a nag, since this
   * modal itself only ever appears once per hand-off.
   */
  postureNotice?: string | null;
}

const OFFER_META: Record<PairingOfferKind, { label: string; description: string; icon: typeof BellRing }> = {
  notifications: {
    label: 'Push notifications',
    description: 'Get an approval or completion alert on this device, even when the app isn’t open.',
    icon: BellRing,
  },
  relay: {
    label: 'Remote connectivity',
    description: 'Reach your daemon through the relay when this device is off your home network.',
    icon: Radio,
  },
  passkey: {
    label: 'Passkey sign-in',
    description: 'Register a passkey on this device to confirm sensitive actions without retyping a token.',
    icon: KeyRound,
  },
};

const STATUS_LABEL: Record<PairingHandoffOutcome['status'], string> = {
  completed: 'Completed',
  declined: 'Declined',
  unavailable: 'Not available',
  failed: 'Failed',
};

const STATUS_TONE: Record<PairingHandoffOutcome['status'], StatusTone> = {
  completed: 'ok',
  declined: 'idle',
  unavailable: 'idle',
  failed: 'bad',
};

type GatheredAccept = {
  notifications?: PairingHandoffCompleteNotificationsAccept;
  relay?: boolean;
  passkey?: PairingHandoffCompletePasskeyAccept;
};

export function PairingHandoffOffers({ offers, onDone, postureNotice }: PairingHandoffOffersProps) {
  const passkeyAvailable = stepUpAvailability().supported;
  // An offer this browser cannot complete starts unchecked, so it reads as declined, not failed.
  const [accepted, setAccepted] = useState<Partial<Record<PairingOfferKind, boolean>>>(() =>
    Object.fromEntries(offers.map((kind) => [kind, kind !== 'passkey' || passkeyAvailable])),
  );
  const [phase, setPhase] = useState<'deciding' | 'submitting' | 'done'>('deciding');
  const [results, setResults] = useState<readonly PairingHandoffOutcome[] | null>(null);
  // What each local ceremony produced. A retry after the daemon request failed resends it
  // instead of creating a second passkey or push subscription on this device.
  const gathered = useRef<GatheredAccept>({});

  async function submit(kinds: readonly PairingOfferKind[], previous: readonly PairingHandoffOutcome[] | null): Promise<void> {
    setPhase('submitting');
    // A plain mutable draft (the public PairingHandoffCompleteInput['accept']
    // shape is readonly, by design, for every OTHER caller), built up here,
    // then handed to complete() as one literal below.
    const accept: GatheredAccept = {};
    const localFailures: Partial<Record<PairingOfferKind, string>> = {};

    if (kinds.includes('notifications') && accepted.notifications) {
      try {
        gathered.current.notifications ??= { ...await ensureBrowserPushSubscription(), deviceId: ensureDeviceId() };
        accept.notifications = gathered.current.notifications;
      } catch (error) {
        localFailures.notifications = describePushSubscribeError(error);
      }
    }
    if (kinds.includes('relay') && accepted.relay) {
      accept.relay = true;
    }
    if (kinds.includes('passkey') && accepted.passkey) {
      try {
        if (!gathered.current.passkey) {
          const ceremony = await registerPasskey({
            userName: typeof window === 'undefined' ? 'operator' : window.location.host,
            userDisplayName: 'GoodVibes operator',
            label: 'Paired device',
          });
          gathered.current.passkey = {
            rpId: ceremony.rpId,
            origin: ceremony.origin,
            credentialId: ceremony.credentialId,
            publicKeyCose: ceremony.publicKeyCose,
          };
        }
        accept.passkey = gathered.current.passkey;
      } catch (error) {
        localFailures.passkey = describeStepUpError(error);
      }
    }

    let serverResults: readonly PairingHandoffOutcome[] | null = null;
    let requestErrorMessage: string | null = null;
    try {
      const response = await platformClient.operator.pairing.handoff.complete({ accept });
      serverResults = response.results;
    } catch (error) {
      requestErrorMessage = formatError(error);
    }

    // The daemon's list is the owner of "this device has a passkey"; the browser keeps only the id as a hint.
    if (accept.passkey && serverResults?.some((r) => r.kind === 'passkey' && r.status === 'completed')) {
      setRegisteredCredential({ credentialId: accept.passkey.credentialId, label: 'Paired device', registeredAt: Date.now() });
    }

    const finalResults: PairingHandoffOutcome[] = offers.map((kind) => {
      if (!kinds.includes(kind)) return previous?.find((r) => r.kind === kind) ?? { kind, status: 'declined' };
      const localFailure = localFailures[kind];
      if (localFailure) return { kind, status: 'failed', detail: localFailure };
      const fromServer = serverResults?.find((r) => r.kind === kind);
      if (fromServer) return fromServer;
      if (accepted[kind]) {
        return { kind, status: 'failed', detail: requestErrorMessage ?? 'No response from the daemon for this offer.' };
      }
      return { kind, status: 'declined' };
    });

    setResults(finalResults);
    setPhase('done');
  }

  const retryKinds = (results ?? []).filter((r) => r.status === 'failed' && accepted[r.kind as PairingOfferKind]).map((r) => r.kind as PairingOfferKind);

  return (
    <Dialog
      open
      title="Finish pairing this device"
      // Closing mid-ceremony would dismiss the offers while the push or passkey
      // registration still runs, hiding its outcome and any way to retry.
      onClose={phase === 'submitting' ? () => undefined : onDone}
      footer={phase === 'done' ? (
        <>
          {retryKinds.length > 0 && (
            <Button onClick={() => void submit(retryKinds, results)}>
              Try again
            </Button>
          )}
          <Button variant="primary" onClick={onDone}>
            Continue to the app
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={phase === 'submitting'} onClick={() => void submit(offers, null)}>
          {phase === 'submitting' ? 'Completing…' : 'Continue'}
        </Button>
      )}
    >
      <div className="pairing-handoff">
        {postureNotice && (
          <p className="banner info pairing-handoff-posture-notice" role="status">{postureNotice}</p>
        )}
        {phase === 'done' ? (
          <>
            <p className="pairing-handoff-note">Here’s what happened with each offer from this pairing link:</p>
            <ul className="pairing-handoff-results">
              {(results ?? []).map((result) => {
                const meta = OFFER_META[result.kind as PairingOfferKind];
                return (
                  <li key={result.kind} className={`pairing-handoff-result pairing-handoff-result--${result.status}`}>
                    <StatusDot tone={STATUS_TONE[result.status]} />
                    <strong className="pairing-handoff-result__name">{meta?.label ?? result.kind}</strong>
                    <span className="pairing-handoff-result__status">{STATUS_LABEL[result.status]}</span>
                    {result.detail && <small className="pairing-handoff-result__detail">{result.detail}</small>}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <p className="pairing-handoff-note">
              This pairing link also offers to set up a few things on this device. Each is optional;
              uncheck anything you’d rather skip.
            </p>
            <ul className="pairing-handoff-offers">
              {offers.map((kind) => {
                const meta = OFFER_META[kind];
                const Icon = meta.icon;
                const disabled = kind === 'passkey' && !passkeyAvailable;
                return (
                  <li key={kind} className="pairing-handoff-offer">
                    <Checkbox
                      className="pairing-handoff-offer__row"
                      checked={Boolean(accepted[kind]) && !disabled}
                      disabled={disabled || phase === 'submitting'}
                      onChange={(checked) => setAccepted((prev) => ({ ...prev, [kind]: checked }))}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span className="pairing-handoff-offer__label">{meta.label}</span>
                    </Checkbox>
                    <p className="pairing-handoff-offer__desc">
                      {disabled ? 'This browser does not support passkeys, so this offer cannot be completed here.' : meta.description}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
