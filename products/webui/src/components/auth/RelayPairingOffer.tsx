import { Radio } from 'lucide-react';
import { describeRelayPairingForConfirmation, type RelayPairingPayload } from '../../lib/relay-pairing';
import { Button } from '../ui/Button';

interface RelayPairingOfferProps {
  readonly pairing: RelayPairingPayload;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}

/**
 * A relay pairing sends this browser's requests, bearer token included, to whichever
 * daemon holds the pinned key, so a link, scan or paste is shown here and stored only
 * when the operator confirms it.
 */
export function RelayPairingOffer({ pairing, onConfirm, onDismiss }: RelayPairingOfferProps) {
  const { relayHost, fingerprint, replacesExisting } = describeRelayPairingForConfirmation(pairing);
  return (
    <div className="banner warning" role="alert">
      <Radio size={16} aria-hidden="true" />
      {' '}
      Connect through the relay at <strong>{relayHost}</strong> to the daemon with key{' '}
      <code>{fingerprint}</code>? Only confirm if the daemon you are pairing with shows the same key.
      {replacesExisting && ' This replaces your current relay pairing.'}
      {' '}
      <Button size="sm" onClick={onConfirm}>Confirm pairing</Button>
      {' '}
      <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
    </div>
  );
}
