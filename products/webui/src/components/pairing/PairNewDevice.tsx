/**
 * Pair a new device from the web UI: the owner's pairing flow (pairing.handoff.create),
 * the same one `goodvibes pair` runs. After a confirm naming the device, the daemon
 * mints the device's own token with the full offer set, and this shows the link it
 * opens as a link and a QR code (the engine's QR matrix the terminal draws), with the
 * bare sign-in code behind a one-time reveal. Nothing is stored: the link and code
 * live in this component until Done, and the daemon serves the token only once.
 */
import { useMemo, useState, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { generateQrMatrix } from '@goodvibes/engine/platform/platform/pairing/qr-generator';
import { QrCode } from 'lucide-react';
import { client as platformClient, GOODVIBES_BASE_URL } from '../../lib/goodvibes';
import { PAIRING_OFFER_KINDS } from '../../lib/pairing';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import type { ConfirmController } from '../ui/ConfirmDialog';

/** The link the new device opens: the daemon's deep link, else this daemon's address with the fragment. */
function pairingLink(result: { readonly deepLink?: string | undefined; readonly fragment: string }): string {
  if (result.deepLink) return result.deepLink;
  const fragment = result.fragment.startsWith('#') ? result.fragment : `#${result.fragment}`;
  return `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/${fragment}`;
}

/** One SVG path of the QR's dark modules, with the four-module quiet zone the standard asks for. */
function PairingQr({ text }: { readonly text: string }) {
  const { size, path } = useMemo(() => {
    const matrix = generateQrMatrix(text);
    let d = '';
    matrix.modules.forEach((row, y) => {
      row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; });
    });
    return { size: matrix.size + 8, path: d };
  }, [text]);
  return (
    <svg
      className="pair-new-device__qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code of the pairing link"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

interface Minted {
  readonly name: string;
  readonly link: string;
  readonly token: string;
}

export function PairNewDevice({ confirm }: { readonly confirm: ConfirmController }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<Minted | null>(null);
  const [codeShown, setCodeShown] = useState(false);
  const [codeRevealed, setCodeRevealed] = useState(false);

  const create = useMutation({
    mutationFn: (deviceName: string) => platformClient.operator.pairing.handoff.create(deviceName, PAIRING_OFFER_KINDS),
    onSuccess: async (result) => {
      setMinted({ name: result.token.name, link: pairingLink(result), token: result.token.token });
      setCodeShown(false);
      setCodeRevealed(false);
      setName('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.pairingTokens });
    },
  });

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const deviceName = name.trim();
    if (!deviceName || create.isPending) return;
    const ok = await confirm.ask({
      title: 'Pair a new device?',
      target: deviceName,
      description: 'The daemon makes a sign-in of its own for this device, as one of your devices. Whoever opens the link or holds the code signs in as it, until you revoke it in this list.',
      confirmLabel: 'Pair the device',
    });
    if (!ok) return;
    create.mutate(deviceName);
  }

  if (minted) {
    return (
      <div className="pair-new-device" role="region" aria-label={`Pairing ${minted.name}`}>
        <p>
          Open this link on <strong>{minted.name}</strong>, or scan the code with it. It signs that device in and offers
          its set-up steps. It is shown only here, once.
        </p>
        <PairingQr text={minted.link} />
        <a className="pair-new-device__link" href={minted.link} target="_blank" rel="noreferrer noopener">{minted.link}</a>
        {codeShown ? (
          <p className="pair-new-device__code">
            Sign-in code, for a device that can only paste one: <code>{minted.token}</code>
          </p>
        ) : !codeRevealed && (
          <Button size="sm" onClick={() => { setCodeShown(true); setCodeRevealed(true); }}>
            Show the sign-in code once
          </Button>
        )}
        <div className="pairing-tokens-legacy__actions">
          <Button variant="primary" onClick={() => { setMinted(null); setCodeShown(false); }}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="pair-new-device__form" onSubmit={(event) => void submit(event)}>
      <Field label="New device name">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Phone" autoComplete="off" />
      </Field>
      <Button type="submit" icon={<QrCode aria-hidden="true" />} disabled={create.isPending || !name.trim()}>
        {create.isPending ? 'Pairing…' : 'Pair a new device'}
      </Button>
      {create.error != null && (
        <div className="banner warning" role="alert">Could not pair the device: {formatError(create.error)}</div>
      )}
    </form>
  );
}
