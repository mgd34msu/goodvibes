/**
 * SecureAddressSettings, the "Secure address" screen (Settings, General,
 * Secure address): an https address for phones, by one of four ways, each
 * explained in the daemon's own words (secureAddress.get carries them, the
 * same words the terminal programs show), so nothing is left to guess: what
 * it does, what it needs from you, what the phone gains, and what is sent
 * where.
 *
 * One change: secureAddress.set. The daemon checks it before writing anything
 * (a name, a token Cloudflare must accept, a certificate and key that must be
 * a pair in force) and answers once the https listener has synced and, for
 * Let's Encrypt, once the authority has answered. No key or token is ever
 * shown: the token field is write-only.
 *
 * On a machine that joined a group whose lead has a secure address, the
 * screen says where it comes from and what it holds, and offers nothing to set.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { invokeMethod } from '../../lib/goodvibes';
import { NO_EVENT_LIST_FRESHNESS } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';
import '../../styles/components/secure-address.css';

const SECURE_ADDRESS_KEY = ['secureAddress', 'get'] as const;

type Choice = 'lets-encrypt' | 'own-files' | 'local-authority' | 'off';

interface ChoiceWords {
  readonly id: 'lets-encrypt' | 'own-files' | 'tailscale' | 'local-authority';
  readonly title: string;
  readonly does: string;
  readonly needs: string;
  readonly phoneGains: string;
  readonly sends: string;
  readonly caution?: string;
}

/** The answer of secureAddress.get, as this screen reads it. */
interface SecureAddressStatus {
  /** A notice no owner channel carried (shown at the top; the daemon marks it given once it is in an answer). */
  readonly notice?: string;
  readonly intro: string;
  readonly choices: readonly ChoiceWords[];
  readonly groupLines: readonly string[];
  readonly node: boolean;
  readonly inForce: {
    readonly on: boolean; readonly certificate: 'local-authority' | 'own-files' | 'lets-encrypt'; readonly servedToNetwork: boolean;
    readonly serving: boolean; readonly port?: number; readonly address?: string; readonly names?: readonly string[];
    readonly notAfter?: number; readonly problem?: string; readonly from?: 'this-machine' | 'group';
    /** Other machines are not served: why a phone cannot open the address yet, in the daemon's words. */
    readonly reach?: string;
  };
  readonly letsEncrypt: {
    readonly domain: string; readonly tokenStored: boolean; readonly tokenUnreadable?: string; readonly issuing: boolean;
    readonly certificate?: { readonly names: readonly string[]; readonly notAfter: number };
    readonly lastAttempt?: { readonly at: number; readonly ok: boolean; readonly words: string };
    readonly addressProblem?: string;
    readonly routerCheck?: { readonly name: string; readonly ok: boolean; readonly words: string };
    readonly addressRecords: Readonly<Record<string, string>>;
  };
  readonly ownFiles: { readonly certFile: string; readonly keyFile: string; readonly check?: { readonly ok: boolean; readonly problem?: string; readonly names: readonly string[]; readonly notAfter?: number } };
  readonly localAuthority: { readonly made: boolean; readonly fingerprint?: string; readonly page?: string };
  readonly tailscale: { readonly address?: string };
  readonly group: {
    readonly following?: { readonly name: string };
    readonly received?: { readonly leadName: string; readonly names: readonly string[]; readonly notAfter: number; readonly receivedAt: number };
    readonly followers: readonly { readonly name: string; readonly address: string; readonly port?: number; readonly covered: boolean; readonly needs?: string }[];
  };
  /** "Issue a new certificate now" (secureAddress.reissue), in the daemon's words; available where it can act. */
  readonly reissue: { readonly title: string; readonly line: string; readonly available: boolean };
  /** "Replace the authority" (secureAddress.replaceAuthority): asked first, opening on No. */
  readonly replaceAuthority?: { readonly title: string; readonly line: string; readonly question: string; readonly available: boolean };
  /** "Serve other machines" (secureAddress.serve): while phones cannot reach the address. */
  readonly serve?: { readonly title: string; readonly line: string; readonly available: boolean };
}

/** The answer of secureAddress.reissue. */
interface SecureAddressReissue {
  readonly ok: boolean;
  readonly words: string;
  readonly status: SecureAddressStatus;
}

/** A certificate's end date in the one form every Secure address screen uses (the local date, month in words, as the daemon's own words write it). */
function day(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
}

/** The four parts of a choice's words, each under its own plain label. */
function ChoiceWordsList({ words }: { words: ChoiceWords }) {
  return (
    <dl className="secure-address__words">
      <dt>What it does</dt><dd>{words.does}</dd>
      <dt>What it needs from you</dt><dd>{words.needs}</dd>
      <dt>What the phone gains</dt><dd>{words.phoneGains}</dd>
      <dt>What is sent where</dt><dd>{words.sends}</dd>
      {words.caution && <><dt>Before you choose it</dt><dd>{words.caution}</dd></>}
    </dl>
  );
}

export function SecureAddressSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: SECURE_ADDRESS_KEY,
    queryFn: () => invokeMethod('secureAddress.get', {}) as Promise<SecureAddressStatus>,
    ...NO_EVENT_LIST_FRESHNESS,
  });
  const [domain, setDomain] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [certFile, setCertFile] = useState<string | null>(null);
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [shownNotice, setShownNotice] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: (input: { certificate: Choice; domain?: string; cloudflareToken?: string; certFile?: string; keyFile?: string }) =>
      invokeMethod('secureAddress.set', input) as Promise<SecureAddressStatus>,
    onSuccess: (answer) => {
      setToken('');
      queryClient.setQueryData(SECURE_ADDRESS_KEY, answer);
    },
  });

  const reissue = useMutation({
    mutationFn: () => invokeMethod('secureAddress.reissue', {}) as Promise<SecureAddressReissue>,
    onSuccess: (answer) => { queryClient.setQueryData(SECURE_ADDRESS_KEY, answer.status); },
  });
  // "Replace the authority" asks first, opening on No; "Serve other machines" acts at once.
  const [asking, setAsking] = useState(false);
  // "No, keep the authority" says in one line that nothing changed.
  const [kept, setKept] = useState(false);
  const replace = useMutation({
    mutationFn: () => invokeMethod('secureAddress.replaceAuthority', {}) as Promise<SecureAddressReissue>,
    onSuccess: (answer) => { setAsking(false); queryClient.setQueryData(SECURE_ADDRESS_KEY, answer.status); },
  });
  const serve = useMutation({
    mutationFn: () => invokeMethod('secureAddress.serve', {}) as Promise<SecureAddressReissue>,
    onSuccess: (answer) => { queryClient.setQueryData(SECURE_ADDRESS_KEY, answer.status); },
  });

  // Every answer lands in the one query (the daemon's change events read it again too): it is the one shown.
  const data = status.data ?? change.data;
  // The daemon marks a notice given once an answer carried it: kept here for as long as this screen is open.
  const arrivedNotice = data?.notice;
  useEffect(() => { if (arrivedNotice) setShownNotice(arrivedNotice); }, [arrivedNotice]);
  if (status.isError && !data) return <div className="banner warning" role="alert">{formatError(status.error)}</div>;
  if (!data) return <p className="settings-empty">Reading the secure address…</p>;

  const words = (id: ChoiceWords['id']) => data.choices.find((choice) => choice.id === id);
  const force = data.inForce;
  const busy = change.isPending || reissue.isPending || replace.isPending || serve.isPending;
  const inForceLine = force.serving
    ? force.reach
      ? `This computer serves ${force.address ?? 'the https address'}${force.notAfter ? `, with a certificate valid until ${day(force.notAfter)}` : ''}. ${force.reach}`
      : `Phones open ${force.address ?? 'the https address'}${force.notAfter ? `, with a certificate valid until ${day(force.notAfter)}` : ''}. The plain http address keeps working.`
    : force.on
      ? `https is switched on but not served: ${force.problem ?? 'no reason given'}`
      : 'https is off: phones use the plain http address, with chat and little else.';

  return (
    <>
      {shownNotice && <div className="banner info" role="status">{shownNotice}</div>}
      <SettingsBlock title="In force now" description={data.intro}>
        <div className="secure-address__status" role="status">
          <StatusDot tone={force.serving && !force.reach ? 'ok' : force.on ? 'bad' : 'idle'} />
          <span>{inForceLine}</span>
        </div>
        {/* Phones cannot reach the address while other machines are not served: the control that serves them. */}
        {force.on && data.serve?.available && (
          <div className="secure-address__reissue">
            <div className="settings-rows">
              <Button disabled={busy} onClick={() => serve.mutate()}>{serve.isPending ? 'Serving other machines…' : data.serve.title}</Button>
            </div>
            <p className="settings-empty">{data.serve.line}</p>
            {serve.isError && <div className="banner warning" role="alert">{formatError(serve.error)}</div>}
          </div>
        )}
        {serve.data && <p className="settings-empty" role="status">{serve.data.words}</p>}
        {data.groupLines.map((line) => <p key={line} className="settings-empty">{line}</p>)}
        {data.group.followers.length > 0 && (
          <ul className="secure-address__list">
            {data.group.followers.map((follower) => (
              <li key={follower.name}>
                <strong>{follower.name}</strong>: {follower.covered ? `opened at https://${follower.address}${follower.port !== undefined ? `:${follower.port}` : ''}` : follower.needs ?? 'not covered by the certificate here'}
              </li>
            ))}
          </ul>
        )}
        {/* "Replace the authority": it cannot be undone, so it asks first, opening on No. */}
        {force.on && !data.node && data.replaceAuthority?.available && (
          <div className="secure-address__reissue">
            {asking ? (
              <div role="alertdialog" aria-label={data.replaceAuthority.title}>
                <p className="settings-empty"><strong>{data.replaceAuthority.question}</strong></p>
                <div className="settings-rows">
                  <Button variant="primary" autoFocus disabled={busy} onClick={() => { setAsking(false); setKept(true); }}>No, keep the authority</Button>
                  <Button disabled={busy} onClick={() => replace.mutate()}>{replace.isPending ? 'Replacing the authority…' : 'Yes, replace the authority'}</Button>
                </div>
              </div>
            ) : (
              <div className="settings-rows">
                <Button disabled={busy} onClick={() => { setKept(false); setAsking(true); }}>{data.replaceAuthority.title}</Button>
              </div>
            )}
            <p className="settings-empty">{data.replaceAuthority.line}</p>
            {kept && !replace.data && <p className="settings-empty" role="status">The authority was kept: nothing changed here or on any phone.</p>}
            {replace.data && <p className="settings-empty" role="status">{replace.data.words}</p>}
            {replace.isError && <div className="banner warning" role="alert">{formatError(replace.error)}</div>}
          </div>
        )}
        {/* "Issue a new certificate now" with its own line and outcome, apart from "Switch https off". */}
        {force.on && !data.node && data.reissue.available && (
          <div className="secure-address__reissue">
            <div className="settings-rows">
              <Button disabled={busy} onClick={() => reissue.mutate()}>{reissue.isPending ? 'Issuing a new certificate…' : data.reissue.title}</Button>
            </div>
            <p className="settings-empty">{data.reissue.line}</p>
            {reissue.data && <p className="settings-empty" role="status">{reissue.data.words}</p>}
            {reissue.isError && <div className="banner warning" role="alert">{formatError(reissue.error)}</div>}
          </div>
        )}
        {force.on && !data.node && (
          <div className="settings-rows">
            <Button disabled={busy} onClick={() => change.mutate({ certificate: 'off' })}>Switch https off</Button>
          </div>
        )}
      </SettingsBlock>

      {data.node ? (
        <SettingsBlock title="From the lead of your group" description={data.groupLines[0]}>
          {data.group.received ? (
            <p className="settings-empty">
              Received from {data.group.received.leadName} on {day(data.group.received.receivedAt)} at {new Date(data.group.received.receivedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}: a certificate for {data.group.received.names.join(', ')}, valid until {day(data.group.received.notAfter)}.
              It is renewed there and sent here by itself.
            </p>
          ) : <p className="settings-empty">Nothing received yet.</p>}
        </SettingsBlock>
      ) : (
        <>
          {words('lets-encrypt') && (
            <SettingsBlock title={words('lets-encrypt')!.title} testId="secure-address-lets-encrypt">
              <ChoiceWordsList words={words('lets-encrypt')!} />
              <form
                className="secure-address__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  change.mutate({ certificate: 'lets-encrypt', domain: (domain ?? data.letsEncrypt.domain).trim(), ...(token.trim() ? { cloudflareToken: token.trim() } : {}) });
                }}
              >
                <Field label="Your name for the address" help="A name under a domain you own, such as gv.example.com. Phones open it; the machines of your group get names under it.">
                  <Input value={domain ?? data.letsEncrypt.domain} onChange={(event) => setDomain(event.target.value)} placeholder="gv.example.com" autoComplete="off" spellCheck={false} />
                </Field>
                {/* A secret store that could not be read is not "no token": the token already given is not asked for again. */}
                {!data.letsEncrypt.tokenStored && data.letsEncrypt.tokenUnreadable ? (
                  <div className="banner warning" role="status">{data.letsEncrypt.tokenUnreadable}</div>
                ) : (
                  <Field
                    label="Cloudflare API token"
                    help={data.letsEncrypt.tokenStored
                      ? 'A token is stored; leave this empty to use it, or give a new one to replace it.'
                      : 'Needed once: a token with Zone, DNS, Edit on the zone that holds the name (dash.cloudflare.com, My Profile, API Tokens, template "Edit zone DNS"). It is kept in the daemon\'s secret store and never shown again.'}
                  >
                    <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
                  </Field>
                )}
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? 'Asking Let\'s Encrypt…' : force.certificate === 'lets-encrypt' && force.on ? 'Use this name again' : 'Get the certificate and use it'}
                </Button>
              </form>
              {data.letsEncrypt.lastAttempt && (
                <div className={`banner ${data.letsEncrypt.lastAttempt.ok ? 'info' : 'warning'}`} role="status">{data.letsEncrypt.lastAttempt.words}</div>
              )}
              {data.letsEncrypt.addressProblem && <div className="banner warning" role="status">{data.letsEncrypt.addressProblem}</div>}
              {data.letsEncrypt.routerCheck && (
                <div className={`banner ${data.letsEncrypt.routerCheck.ok ? 'info' : 'warning'}`} role="status">{data.letsEncrypt.routerCheck.words}</div>
              )}
            </SettingsBlock>
          )}

          {words('own-files') && (
            <SettingsBlock title={words('own-files')!.title} testId="secure-address-own-files">
              <ChoiceWordsList words={words('own-files')!} />
              <form
                className="secure-address__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  change.mutate({ certificate: 'own-files', certFile: (certFile ?? data.ownFiles.certFile).trim(), keyFile: (keyFile ?? data.ownFiles.keyFile).trim() });
                }}
              >
                <Field label="Certificate file (with its chain)" help="A path on the computer running GoodVibes.">
                  <Input value={certFile ?? data.ownFiles.certFile} onChange={(event) => setCertFile(event.target.value)} placeholder="/etc/ssl/goodvibes/fullchain.pem" autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Its private key file" help="Unencrypted PEM. The setting keeps the path; the key is read on that computer only.">
                  <Input value={keyFile ?? data.ownFiles.keyFile} onChange={(event) => setKeyFile(event.target.value)} placeholder="/etc/ssl/goodvibes/privkey.pem" autoComplete="off" spellCheck={false} />
                </Field>
                <Button type="submit" variant="primary" disabled={busy}>Check these files and use them</Button>
              </form>
              {data.ownFiles.check && (
                <div className={`banner ${data.ownFiles.check.ok ? 'info' : 'warning'}`} role="status">
                  {data.ownFiles.check.ok
                    ? `Covers ${data.ownFiles.check.names.join(', ')}; valid until ${day(data.ownFiles.check.notAfter)}.`
                    : data.ownFiles.check.problem}
                </div>
              )}
            </SettingsBlock>
          )}

          {words('tailscale') && (
            <SettingsBlock title={words('tailscale')!.title} testId="secure-address-tailscale">
              <ChoiceWordsList words={words('tailscale')!} />
              {data.tailscale.address
                ? <p className="settings-empty">Served now at <a href={data.tailscale.address} target="_blank" rel="noreferrer">{data.tailscale.address}</a>. Manage Tailscale serving in Network above.</p>
                : <p className="settings-empty">When Tailscale is installed and signed in on this computer, turn on Tailscale serving in Network above.</p>}
            </SettingsBlock>
          )}

          {words('local-authority') && (
            <SettingsBlock title={words('local-authority')!.title} testId="secure-address-local-authority">
              <ChoiceWordsList words={words('local-authority')!} />
              {data.localAuthority.page && (
                <p className="settings-empty secure-address__phone-link">On each phone, once: open <code>{data.localAuthority.page}</code>{data.localAuthority.fingerprint ? <> (the certificate's fingerprint is <code>{data.localAuthority.fingerprint}</code>)</> : null}.</p>
              )}
              <div className="settings-rows">
                <Button variant="primary" disabled={busy} onClick={() => change.mutate({ certificate: 'local-authority' })}>Use GoodVibes' own certificate</Button>
              </div>
            </SettingsBlock>
          )}
        </>
      )}
      {change.isError && <div className="banner warning" role="alert">{formatError(change.error)}</div>}
    </>
  );
}
