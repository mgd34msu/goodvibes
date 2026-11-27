/**
 * SignedOutGate, the front door: shown INSTEAD of the shell while auth.current
 * reports signed out, so nothing behind it can make a request that 401s.
 *
 * Plain words first (ux A1.5): the heading, one sentence naming `goodvibes pair`,
 * and the scan button. Scanning the QR that command shows opens a link back here
 * with the sign-in code in the URL fragment (usePairingHandoff), or, with the
 * in-page scanner (PairingQrScanner), reads that link or the JSON payload the
 * desktop app and terminal print. A pasted link or payload is read the same way
 * as a scan before the text is tried as a bare code. A scan feeds the SAME tokenMutation /
 * loginMutation / relay calls the forms use, so a code is checked in one place
 * and a refusal is reported in one place.
 *
 * Everything else sits in "Other ways to sign in", in this order: paste a
 * sign-in code (setExplicitAuthToken has the daemon check it and bind it to an
 * HttpOnly cookie, or, over the relay, holds it in memory; a refused code
 * changes nothing), the relay code for a device that cannot reach the computer
 * directly, the username and password (the first sign-in with the generated
 * first-run password sets the owner's own, asked for here when the daemon says
 * so), and where to find a code.
 *
 * `pairingError` is set when a pairing link's code was refused (an expired or
 * malformed QR), so a failed scan is never a silent bounce back to this screen.
 *
 * A scanned code that names another daemon address is never sent to this
 * page's daemon: a credential goes only to the daemon it was issued for. The
 * page offers "Open the daemon at <origin>", which carries a sign-in code
 * there in the URL fragment (never sent to any server); a username and
 * password are not carried and are typed again there.
 */

import { Camera, KeyRound, Radio, ShieldCheck } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GOODVIBES_BASE_URL, isFirstSignInPasswordNeeded, login, setExplicitAuthToken } from '../../lib/goodvibes';
import { formatError, isAuthExpiredError, isDaemonUnreachableError } from '../../lib/errors';
import { decodeRelayPairingCode, getStoredRelayPairing, storeRelayPairing, type RelayPairingPayload } from '../../lib/relay-pairing';
import { RelayPairingOffer } from './RelayPairingOffer';
import {
  describeScannedPairing,
  isDifferentOrigin,
  parseScannedPairing,
  type ScannedPairing,
} from '../../lib/pairing-qr';
import { PairingQrScanner } from '../pairing/PairingQrScanner';
import { Disclosure } from '../data-view/DataView';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Field';
import '../../styles/components/auth-gate.css';

// Credential validation can replace the identity boundary before it rejects.
// Keep its error outside that private subtree so the new gate can report it.
let signInError: unknown = null;
let signInsInFlight = 0;
const signInListeners = new Set<() => void>();
const subscribeSignIn = (listener: () => void) => { signInListeners.add(listener); return () => { signInListeners.delete(listener); }; };
const readSignInError = () => signInError;
async function validateSignIn<T>(read: () => Promise<T>): Promise<T> {
  signInError = null;
  signInsInFlight += 1;
  for (const listener of signInListeners) listener();
  try { return await read(); }
  catch (error) {
    signInError = error;
    for (const listener of signInListeners) listener();
    throw error;
  }
  finally { signInsInFlight -= 1; }
}
// The token typed into the field. Checking it replaces the identity boundary, which
// remounts this gate; a refused token must still be in the field to correct, so the
// text lives here, in memory only, until a sign-in succeeds.
let typedToken = '';
// Whether "Other ways to sign in" is open. Kept beside the typed code for the same
// reason: a refused code remounts this gate, and its message must not be folded away.
let otherWaysOpenNow = false;
// The relay section's state: holding a relay replaces the identity boundary (a pairing is
// a change of identity), which remounts this gate, and its confirmation must still show.
let relayPasteOpenNow = false;
let relayReadyNow = false;
// A scanned pairing for another daemon address, held in memory only (never in
// component state, never rendered) until the person opens that daemon or scans again.
let scannedElsewhere: { readonly origin: string; readonly token: string | null } | null = null;

/** A failure belongs to the gate that showed it: a later sign-out must open on a clean gate. */
function retireSignInError(): void {
  // A gate replaced while a check is still running is the case the module state exists
  // for, so only a gate that leaves with nothing in flight drops the old failure.
  if (signInsInFlight > 0 || signInError === null) return;
  signInError = null;
  for (const listener of signInListeners) listener();
}

export interface SignedOutGateProps {
  /** Set when a `#pair=…` hand-off token was rejected by the daemon (expired/invalid QR). */
  pairingError?: unknown;
  /** Set when a `#relay=…` hand-off code was malformed (see useRelayPairingHandoff). */
  relayPairingError?: unknown;
}

export function SignedOutGate({ pairingError, relayPairingError }: SignedOutGateProps = {}) {
  const queryClient = useQueryClient();
  const validationError = useSyncExternalStore(subscribeSignIn, readSignInError, readSignInError);
  useEffect(() => retireSignInError, []);
  const [token, setTokenState] = useState(() => typedToken);
  const setToken = (value: string) => { typedToken = value; setTokenState(value); };
  const [otherWaysOpen, setOtherWaysOpenState] = useState(() => otherWaysOpenNow || typedToken !== '' || validationError != null);
  const setOtherWaysOpen = (open: boolean) => { otherWaysOpenNow = open; setOtherWaysOpenState(open); };
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // The owner's own password, asked for when the daemon says this is the first sign-in with the generated one.
  const [newPassword, setNewPassword] = useState('');
  const [showRelayPaste, setShowRelayPasteState] = useState(() => relayPasteOpenNow);
  const setShowRelayPaste = (next: boolean | ((current: boolean) => boolean)) => {
    setShowRelayPasteState((current) => { relayPasteOpenNow = typeof next === 'function' ? next(current) : next; return relayPasteOpenNow; });
  };
  const [relayCode, setRelayCode] = useState('');
  const [relayPasteError, setRelayPasteError] = useState<unknown>(null);
  const [relayStored, setRelayStoredState] = useState(() => relayReadyNow);
  const setRelayStored = (ready: boolean) => { relayReadyNow = ready; setRelayStoredState(ready); };
  const [relayOffer, setRelayOffer] = useState<RelayPairingPayload | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanOriginNote, setScanOriginNote] = useState<string | null>(null);

  // Both credentials arrive as mutation VARIABLES rather than being read off
  // component state, so a scan and a typed entry run the identical call. Reading
  // state here instead would have forced the scanner to stage its token in the
  // visible input first, which would both render the secret and race the submit.
  const tokenMutation = useMutation({
    mutationFn: (value: string) => validateSignIn(() => setExplicitAuthToken(value.trim())),
    onSuccess: async () => {
      setToken('');
      // Revalidate everything, auth/boot/health flip to signed-in and the shell reveals.
      await queryClient.cancelQueries();
      await queryClient.invalidateQueries();
    },
    // A refused scan reports under the code field: open the section that holds it.
    onError: () => setOtherWaysOpen(true),
  });

  const loginMutation = useMutation({
    mutationFn: (credentials: { username: string; password: string; newPassword?: string }) =>
      validateSignIn(() => login(credentials.username, credentials.password, credentials.newPassword)),
    onSuccess: async () => {
      setPassword('');
      setNewPassword('');
      typedToken = '';
      await queryClient.cancelQueries();
      await queryClient.invalidateQueries();
    },
  });

  const tokenError = tokenMutation.error ?? (!loginMutation.error ? validationError : null);

  // What `goodvibes pair` prints is a link carrying the code (and a scanned QR's JSON is
  // pasteable too): read it as a scan first, so the link's code, its daemon address, a
  // password payload or a relay code each go where a scan sends them. Text that is no
  // pairing payload is a bare code.
  function submitToken(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const pasted = token.trim();
    if (!pasted) return;
    let parsed: ScannedPairing;
    try {
      parsed = parseScannedPairing(pasted);
    } catch {
      tokenMutation.mutate(pasted);
      return;
    }
    acceptScan(parsed, 'paste');
  }

  // Relay pairing is transport-only, it never signs anyone in, so this is a plain
  // synchronous decode (lib/relay-pairing.ts), no useMutation/network round trip. The
  // decoded pairing is only offered: it is stored when the operator confirms it. decodeRelayPairingCode throws the platform's own GoodVibesError on a
  // malformed code; formatError renders that the same honest way as every other
  // rejection on this screen.
  function submitRelayCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRelayPasteError(null);
    setRelayStored(false);
    if (!relayCode.trim()) return;
    try {
      setRelayOffer(decodeRelayPairingCode(relayCode));
      setRelayCode('');
    } catch (err) {
      setRelayPasteError(err);
    }
  }

  // The first sign-in with the generated first-run password: it signs in only by setting the owner's own password.
  const settingOwnPassword = isFirstSignInPasswordNeeded(loginMutation.error) || newPassword !== '';

  function submitLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username || !password) return;
    loginMutation.mutate(newPassword ? { username, password, newPassword } : { username, password });
  }

  function storeScannedRelay(code: string) {
    setRelayPasteError(null);
    setRelayStored(false);
    try {
      setRelayOffer(decodeRelayPairingCode(code));
    } catch (err) {
      setRelayPasteError(err);
    }
  }

  function confirmRelayOffer() {
    if (relayOffer === null) return;
    storeRelayPairing(relayOffer);
    setRelayOffer(null);
    setRelayStored(true);
  }

  // The one place a scan turns into an action. Every branch hands off to the
  // same call the corresponding manual form uses; nothing new signs anyone in,
  // and the scanned secret is never written to component state or rendered.
  // Plain function, not useCallback: PairingQrScanner reads this through a ref
  // precisely so an unstable identity cannot restart its camera.
  function acceptScan(scanned: ScannedPairing, from: 'scan' | 'paste' = 'scan') {
    setScanOpen(false);
    setScanNotice(from === 'scan' ? describeScannedPairing(scanned) : null);
    scannedElsewhere = null;
    // A sign-in for another daemon is never submitted here: it is offered for that daemon instead.
    if (scanned.kind !== 'relay' && scanned.url && isDifferentOrigin(scanned.url, GOODVIBES_BASE_URL)) {
      const origin = new URL(scanned.url).origin;
      scannedElsewhere = { origin, token: scanned.kind === 'token' ? scanned.token : null };
      setScanOriginNote(origin);
      return;
    }
    setScanOriginNote(null);
    switch (scanned.kind) {
      case 'token':
        tokenMutation.mutate(scanned.token);
        break;
      case 'password':
        loginMutation.mutate({ username: scanned.username, password: scanned.password });
        break;
      case 'relay':
        storeScannedRelay(scanned.relayCode);
        // A relay pairing is transport-only, so the sign-in step still has to
        // happen; opening the relay section points at what is left to do.
        setShowRelayPaste(true);
        break;
    }
  }

  return (
    <div className="signed-out-gate" role="main">
      <div className="signed-out-card">
        <div className="signed-out-mark">
          <ShieldCheck size={24} aria-hidden="true" />
        </div>
        <h1>Sign in to GoodVibes</h1>
        <p className="signed-out-lede">
          Run <code>goodvibes pair</code> on the computer running GoodVibes, then scan the code it shows, or
          open the link it prints in a browser on that computer.
        </p>

        {pairingError != null && (
          <div className="banner warning" role="alert">
            <span>That code didn&rsquo;t work. It may have expired; run <code>goodvibes pair</code> again.</span>
          </div>
        )}

        {relayPairingError != null && (
          <div className="banner warning" role="alert">
            That relay link wasn&rsquo;t recognised. Scan a new relay code, or paste one under
            Other ways to sign in.
          </div>
        )}

        <Button
          variant="primary"
          className="signed-out-scan"
          icon={<Camera aria-hidden="true" />}
          onClick={() => {
            setScanNotice(null);
            setScanOriginNote(null);
            setScanOpen(true);
          }}
        >
          Scan the code
        </Button>

        {scanNotice != null && (
          <div className="banner" role="status">
            {scanNotice}.
          </div>
        )}

        {scanOriginNote != null && (
          <div className="banner warning" role="status">
            That code is for GoodVibes at <code>{scanOriginNote}</code>, and this page is at{' '}
            <code>{GOODVIBES_BASE_URL}</code>. It was not sent here: a sign-in goes only to the
            daemon it was made for.
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const held = scannedElsewhere;
                if (!held) return;
                scannedElsewhere = null;
                // The code rides in the fragment, which no server receives; a password is typed again there.
                window.location.assign(held.token ? `${held.origin}/#pair=${encodeURIComponent(held.token)}` : `${held.origin}/`);
              }}
            >
              Open the daemon at {scanOriginNote}
            </Button>
          </div>
        )}

        <Dialog open={scanOpen} onClose={() => setScanOpen(false)} title="Scan the code">
          <PairingQrScanner onScanned={acceptScan} onCancel={() => setScanOpen(false)} />
        </Dialog>

        <details
          className="dv-disclosure signed-out-other"
          open={otherWaysOpen}
          onToggle={(event) => setOtherWaysOpen(event.currentTarget.open)}
        >
          <summary className="dv-disclosure__summary">Other ways to sign in</summary>
          <div className="dv-disclosure__body signed-out-other__body">
            <form className="signed-out-form" onSubmit={submitToken}>
              <Field label="Paste the link or code goodvibes pair prints">
                <Input
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="Paste the link or code goodvibes pair prints"
                />
              </Field>
              {tokenError != null && (
                <div className="banner warning" role="alert">
                  {isAuthExpiredError(tokenError)
                    ? <span>GoodVibes refused that code: it was already used, revoked, made for a different daemon, or mistyped. Run <code>goodvibes pair</code> on the computer running GoodVibes for a new one.</span>
                    : isDaemonUnreachableError(tokenError)
                      ? `The code was not checked: this page could not reach GoodVibes (${formatError(tokenError)}). A phone must be on the same network as the computer running GoodVibes, or use Tailscale. Try again.`
                      : `Couldn't check that code: ${formatError(tokenError)}. Try again.`}
                </div>
              )}
              <Button variant="primary" type="submit" disabled={tokenMutation.isPending || !token.trim()}>
                {tokenMutation.isPending ? 'Checking…' : 'Sign in'}
              </Button>
            </form>

            <div className="signed-out-secondary">
              <Button
                variant="ghost"
                size="sm"
                className="signed-out-toggle"
                icon={<Radio aria-hidden="true" />}
                onClick={() => setShowRelayPaste((current) => !current)}
                aria-expanded={showRelayPaste}
              >
                Not on the same network as your computer?
              </Button>
              {showRelayPaste && (
                <form className="signed-out-form signed-out-password" onSubmit={submitRelayCode}>
                  <p className="signed-out-note">
                    Paste the relay code GoodVibes shows on your computer (a different code from the
                    sign-in one). It lets this device reach your computer through the relay; it does
                    not sign you in, so you still need a sign-in code. Over the relay, live updates
                    (a reply as it is written, agent progress) refresh every few seconds instead.
                  </p>
                  <Field label="Relay code">
                    <Input
                      value={relayCode}
                      onChange={(event) => setRelayCode(event.target.value)}
                      type="text"
                      autoComplete="off"
                      placeholder="gvrelay1.…"
                    />
                  </Field>
                  <Button type="submit" disabled={!relayCode.trim()}>
                    Check relay code
                  </Button>
                  {relayOffer !== null && (
                    <RelayPairingOffer pairing={relayOffer} onConfirm={confirmRelayOffer} onDismiss={() => setRelayOffer(null)} />
                  )}
                  {relayStored && getStoredRelayPairing() !== null && (
                    <div className="banner" role="status">
                      Relay ready. This page uses it by itself when it can&rsquo;t reach your
                      computer directly, until you reload it.
                    </div>
                  )}
                  {relayPasteError != null && (
                    <div className="banner warning" role="alert">
                      That isn&rsquo;t a relay code. Copy it again whole, starting with gvrelay1.
                    </div>
                  )}
                </form>
              )}
            </div>

            <div className="signed-out-secondary">
              <Button
                variant="ghost"
                size="sm"
                className="signed-out-toggle"
                icon={<KeyRound aria-hidden="true" />}
                onClick={() => setShowPassword((current) => !current)}
                aria-expanded={showPassword}
              >
                Use a username and password
              </Button>
              {showPassword && (
                <form className="signed-out-form signed-out-password" onSubmit={submitLogin}>
                  <p className="signed-out-note">
                    Your username and the password you chose. The first time, use the first-run password
                    GoodVibes made (in <code>~/.goodvibes/tui/auth-bootstrap.txt</code>): that sign-in sets a
                    password of your own, and the first-run one stops working.
                  </p>
                  <Field label="Username">
                    <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
                  </Field>
                  <Field label="Password">
                    <Input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type="password"
                      autoComplete="current-password"
                    />
                  </Field>
                  {settingOwnPassword && (
                    <Field label="A password of your own (at least 8 characters)">
                      <Input
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        type="password"
                        autoComplete="new-password"
                      />
                    </Field>
                  )}
                  <Button type="submit" disabled={loginMutation.isPending || !username || !password || (settingOwnPassword && newPassword.length < 8)}>
                    {loginMutation.isPending ? 'Signing in…' : settingOwnPassword ? 'Set my password and sign in' : 'Sign in with password'}
                  </Button>
                  {loginMutation.error && (
                    <div className="banner warning" role="alert">
                      {isFirstSignInPasswordNeeded(loginMutation.error)
                        ? 'This is the first sign-in with the first-run password: choose a password of your own above to finish it.'
                        : formatError(loginMutation.error)}
                    </div>
                  )}
                </form>
              )}
            </div>

            <Disclosure summary="Where do I find a code?">
              <ul className="signed-out-help">
                <li>
                  Run <code>goodvibes pair</code> on the computer running GoodVibes. When a phone
                  can reach GoodVibes, it shows a QR code that signs you in when you scan it, and
                  its link.
                </li>
                <li>
                  When GoodVibes serves only that computer, <code>goodvibes pair</code> prints a
                  link and a sign-in code for a browser on that computer, and the command that
                  lets a phone reach it.
                </li>
                <li>
                  <code>goodvibes-daemon pair</code>, on that computer, prints the daemon&rsquo;s
                  own sign-in link the same way.
                </li>
              </ul>
            </Disclosure>
          </div>
        </details>
      </div>
    </div>
  );
}
