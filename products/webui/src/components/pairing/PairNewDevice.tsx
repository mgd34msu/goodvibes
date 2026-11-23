/**
 * Pair a new device from the web UI: the owner's pairing flow (pairing.handoff.create),
 * the same one `goodvibes pair` runs. After a confirm naming the device, the daemon
 * mints the device's own token with the full offer set, and this shows the link it
 * opens as a link and a QR code (the engine's QR matrix the terminal draws), with the
 * bare sign-in code behind a one-time reveal. Nothing is stored: the link and code
 * live in this component until Done, and the daemon serves the token only once.
 * Before any of that the daemon is asked (pairing.posture.get) whether a phone can
 * open the address a code would carry; when it cannot, the daemon's numbered steps
 * are shown, and the form makes a sign-in link for a browser on the daemon's own
 * machine instead (`forThisMachine`), shown with no QR code.
 */
import { useMemo, useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { generateQrMatrix } from '@goodvibes/engine/platform/platform/pairing/qr-generator';
import { QrCode } from 'lucide-react';
import { client as platformClient, GOODVIBES_BASE_URL, type OriginPosture } from '../../lib/goodvibes';
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

/** One of the daemon's numbered steps for a code a phone could not open. */
type ReachStep = NonNullable<NonNullable<OriginPosture['reach']>['steps']>[number];

const STEP_LABEL: Readonly<Record<ReachStep['state'], string>> = { done: 'Done', next: 'Next', then: 'Then' };

/**
 * When the daemon says a phone could not open a code: why, and the daemon's own
 * numbered steps that let a phone reach it. A command step is run in a terminal
 * on the daemon's machine, which a person reading this in a browser (often on
 * that same machine, over its loopback address) is told plainly. `lead` is the
 * sentence above the steps; `onCheckAgain` asks the daemon again.
 */
function UnreachableSteps({ reach, lead, onCheckAgain, checking }: {
  readonly reach: NonNullable<OriginPosture['reach']>;
  readonly lead: string;
  readonly onCheckAgain?: (() => void) | undefined;
  readonly checking?: boolean | undefined;
}) {
  return (
    <div className="banner warning pair-new-device__unreachable" role="status">
      <p>{lead}</p>
      <ol className="pair-new-device__steps">
        {(reach.steps ?? []).map((step, index) => (
          <li key={index}>
            <strong>{STEP_LABEL[step.state]}:</strong>{' '}
            {step.command
              ? <>in a terminal on the daemon&apos;s machine, run <code>{step.text}</code></>
              : step.text}
          </li>
        ))}
      </ol>
      {onCheckAgain && <Button size="sm" onClick={onCheckAgain} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</Button>}
    </div>
  );
}

/** Why a phone cannot open a code, as the end of a sentence. */
function unreachableWhy(reach: NonNullable<OriginPosture['reach']>): string {
  return reach.reason ?? 'the daemon serves only its own machine';
}

interface Minted {
  readonly name: string;
  readonly link: string;
  readonly token: string;
  /** Set when the link was made for a browser on the daemon's machine, because a phone could not open it. */
  readonly forThisMachine?: NonNullable<OriginPosture['reach']> | undefined;
}

export function PairNewDevice({ confirm }: { readonly confirm: ConfirmController }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<Minted | null>(null);
  const [codeShown, setCodeShown] = useState(false);
  const [codeRevealed, setCodeRevealed] = useState(false);
  // The daemon's answer about the address a code would carry, read before anything
  // is minted: a code a phone could not open is never asked for.
  const address = useQuery({
    queryKey: queryKeys.pairingAddress,
    queryFn: () => platformClient.operator.pairing.posture.get(),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  const unreachable = address.data?.posture.reach?.otherDevices === false ? address.data.posture.reach : undefined;

  const create = useMutation({
    // A phone could not open a code: the daemon makes one for a browser on its own machine instead.
    mutationFn: (deviceName: string) => platformClient.operator.pairing.handoff.create(deviceName, PAIRING_OFFER_KINDS, unreachable !== undefined),
    onSuccess: async (result) => {
      setMinted({ name: result.token.name, link: pairingLink(result), token: result.token.token, forThisMachine: unreachable });
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
      title: unreachable ? 'Sign in a browser on the computer running GoodVibes?' : 'Pair a new device?',
      target: deviceName,
      description: unreachable
        ? 'The daemon makes a sign-in of its own for that browser, as one of your devices. Its link opens only on the computer running GoodVibes. Whoever opens the link or holds the code signs in as it, until you revoke it in this list.'
        : 'The daemon makes a sign-in of its own for this device, as one of your devices. Whoever opens the link or holds the code signs in as it, until you revoke it in this list.',
      confirmLabel: unreachable ? 'Make the link' : 'Pair the device',
    });
    if (!ok) return;
    create.mutate(deviceName);
  }

  if (minted) {
    return (
      <div className="pair-new-device" role="region" aria-label={`Pairing ${minted.name}`}>
        {minted.forThisMachine ? (
          <>
            <UnreachableSteps
              reach={minted.forThisMachine}
              lead={`This link signs in a browser on the computer running GoodVibes. A phone cannot open it: ${unreachableWhy(minted.forThisMachine)}.`}
            />
            <p>
              Open this link in a browser on that computer, or paste the sign-in code on its sign-in page. It is shown
              only here, once.
            </p>
          </>
        ) : (
          <>
            <p>
              Open this link on <strong>{minted.name}</strong>, or scan the code with it. It signs that device in and offers
              its set-up steps. It is shown only here, once.
            </p>
            <PairingQr text={minted.link} />
          </>
        )}
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
      {unreachable && (
        <UnreachableSteps
          reach={unreachable}
          lead={`No pairing code for a phone: a phone could not open it yet (${unreachableWhy(unreachable)}). A sign-in link for another browser on the computer running GoodVibes can still be made below.`}
          onCheckAgain={() => void address.refetch()}
          checking={address.isFetching}
        />
      )}
      <Field label={unreachable ? 'Name of the browser to sign in' : 'New device name'}>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={unreachable ? 'e.g. Firefox' : 'e.g. Phone'} autoComplete="off" />
      </Field>
      <Button type="submit" icon={<QrCode aria-hidden="true" />} disabled={create.isPending || !name.trim()}>
        {unreachable ? (create.isPending ? 'Making the link…' : 'Make a sign-in link') : (create.isPending ? 'Pairing…' : 'Pair a new device')}
      </Button>
      {create.error != null && (
        <div className="banner warning" role="alert">Could not pair the device: {formatError(create.error)}</div>
      )}
    </form>
  );
}
