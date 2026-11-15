/**
 * StepUpSettings, the operator-facing passkey management surface for relay step-up.
 *
 * Two ceremonies, wired honestly:
 *   - Register a passkey: navigator.credentials.create (the daemon accepts 'none' attestation),
 *     then persist the resulting COSE public key via the stepup.credentials.register verb so the
 *     daemon can verify later assertions.
 *   - Verify now: mint a server challenge and sign it on this device with one of the passkeys the
 *     daemon lists, proving this device holds one the daemon knows. (The daemon checks the
 *     signature itself on every real mutating relay call.)
 *
 * The daemon's credential list is the record of what is registered. This browser keeps only the
 * id of the passkey it registered (written by this panel and by the pairing hand-off), and every
 * status sentence comes from matching that id against the daemon's list.
 *
 * Every failure, unsupported browser, no authenticator, user cancel, register/verify error, is
 * rendered plainly with a specific message; nothing is faked or silently swallowed.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useToast } from '../../lib/toast';
import { client as platformClient, type StepUpCredentialSummary } from '../../lib/goodvibes';
import {
  clearRegisteredCredential,
  describeStepUpError,
  getRegisteredCredential,
  registerPasskey,
  runAssertion,
  setRegisteredCredential,
  stepUpAvailability,
  StepUpError,
  type RegisteredCredentialRecord,
} from '../../lib/stepup';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';

export function StepUpSettings() {
  const { toast } = useToast();
  const availability = stepUpAvailability();
  const [registered, setRegistered] = useState<RegisteredCredentialRecord | null>(() => getRegisteredCredential());
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'register' | 'verify' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the daemon answers; a failed read leaves it null and says so.
  const [daemonCredentials, setDaemonCredentials] = useState<readonly StepUpCredentialSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refreshCredentials = useCallback(async () => {
    try {
      const result = await platformClient.operator.stepup.listCredentials();
      setDaemonCredentials(result.credentials);
      setListError(null);
    } catch (listFailure) {
      setListError(`The daemon's registered passkeys could not be read. ${describeStepUpError(listFailure)}`);
    }
  }, []);

  useEffect(() => { void refreshCredentials(); }, [refreshCredentials]);

  // The daemon's list decides; the local id only says which listed passkey this browser made.
  const onDaemon = registered && daemonCredentials ? daemonCredentials.find((credential) => credential.credentialId === registered.credentialId) : undefined;
  const status: { tone: 'ok' | 'idle' | 'warn'; text: string } = daemonCredentials === null
    ? { tone: 'idle', text: 'Reading the daemon’s registered passkeys…' }
    : onDaemon
      ? { tone: 'ok', text: `The passkey this browser registered${onDaemon.label ? ` (${onDaemon.label})` : ''} is registered with the daemon.` }
      : registered
        ? { tone: 'warn', text: 'The passkey this browser registered is no longer on the daemon’s list, so it cannot confirm relay actions. Register a new one.' }
        : daemonCredentials.length > 0
          ? { tone: 'ok', text: `The daemon has ${daemonCredentials.length === 1 ? 'one registered passkey' : `${daemonCredentials.length} registered passkeys`}. If one is on this device, Verify now confirms it.` }
          : { tone: 'idle', text: 'The daemon has no registered passkey yet.' };

  const handleRemove = async (credentialId: string) => {
    setBusy('remove');
    setError(null);
    try {
      await platformClient.operator.stepup.removeCredential(credentialId);
      if (registered?.credentialId === credentialId) {
        clearRegisteredCredential();
        setRegistered(null);
      }
      toast({ title: 'Passkey removed', description: 'The daemon no longer accepts it for relay actions.', tone: 'success' });
    } catch (removeError) {
      setError(describeStepUpError(removeError));
    } finally {
      setBusy(null);
      await refreshCredentials();
    }
  };

  const handleRegister = async () => {
    setBusy('register');
    setError(null);
    // The authenticator keeps the passkey whether or not the daemon records it.
    let passkeyCreated = false;
    try {
      const ceremony = await registerPasskey({
        userName: typeof window === 'undefined' ? 'operator' : window.location.host,
        userDisplayName: 'GoodVibes operator',
        label: label.trim() || undefined,
      });
      passkeyCreated = true;
      const result = await platformClient.operator.stepup.registerCredential({
        rpId: ceremony.rpId,
        origin: ceremony.origin,
        credentialId: ceremony.credentialId,
        publicKeyCose: ceremony.publicKeyCose,
        signCount: ceremony.signCount,
        userVerification: 'required',
        label: label.trim() || undefined,
      });
      const record: RegisteredCredentialRecord = {
        credentialId: result.credential.credentialId,
        label: result.credential.label ?? (label.trim() || undefined),
        registeredAt: Date.now(),
      };
      setRegisteredCredential(record); // persist to this device
      setRegistered(record);
      void refreshCredentials();
      setLabel('');
      toast({ title: 'Passkey registered', description: 'This device can now confirm relay actions.', tone: 'success' });
    } catch (registerError) {
      setError(
        passkeyCreated
          ? `${describeStepUpError(registerError)} A passkey was already created on this device, but the daemon did not record it, so it cannot confirm anything. Delete it in this device's passkey settings, then register again.`
          : describeStepUpError(registerError),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleVerify = async () => {
    setBusy('verify');
    setError(null);
    try {
      const [challenge, listed] = await Promise.all([
        platformClient.operator.stepup.mintChallenge({}),
        platformClient.operator.stepup.listCredentials(),
      ]);
      setDaemonCredentials(listed.credentials);
      if (listed.credentials.length === 0) throw new StepUpError('no-credential', 'The daemon has no registered passkey.');
      await runAssertion({ challenge: challenge.challenge, credentialIds: listed.credentials.map((credential) => credential.credentialId) });
      toast({
        title: 'Passkey verified',
        description: 'This device signed with a passkey the daemon lists. The daemon checks the signature on every real relay action.',
        tone: 'success',
      });
    } catch (verifyError) {
      setError(describeStepUpError(verifyError));
    } finally {
      setBusy(null);
    }
  };

  const handleForget = () => {
    clearRegisteredCredential();
    setRegistered(null);
    toast({ title: 'Passkey forgotten on this device', description: 'The daemon still holds the credential; remove it from the list below to stop it confirming relay actions.' });
  };

  return (
    <SettingsBlock
      className="settings-stepup"
      title="Passkey confirmation"
      description="When GoodVibes reaches the daemon over the relay, actions that change something (sending a message, answering a permission ask, controlling a session) need a passkey confirmation. Register a passkey on this device to confirm them inline."
    >
      {!availability.supported ? (
        <div className="banner warning" role="status">
          {availability.reason ?? 'Passkeys are not supported in this browser.'}
        </div>
      ) : (
        <>
          <div className="stepup-status" role="status">
            <StatusDot tone={status.tone} />
            <span>{status.text}</span>
          </div>

          <Field label="Passkey label (optional)">
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. My laptop"
              disabled={busy !== null}
            />
          </Field>

          <div className="stepup-actions">
            <Button variant="primary" onClick={() => void handleRegister()} disabled={busy !== null}>
              {busy === 'register' ? 'Waiting for passkey…' : onDaemon ? 'Register a new passkey' : 'Register a passkey'}
            </Button>
            <Button onClick={() => void handleVerify()} disabled={busy !== null}>
              {busy === 'verify' ? 'Waiting for passkey…' : 'Verify now'}
            </Button>
            {registered && (
              <Button variant="ghost" icon={<Trash2 aria-hidden="true" />} onClick={handleForget} disabled={busy !== null}>
                Forget on this device
              </Button>
            )}
          </div>
        </>
      )}

      {daemonCredentials && (
        <div className="stepup-credentials">
          <p>{daemonCredentials.length === 0 ? 'The daemon has no registered passkeys.' : 'Passkeys registered on the daemon:'}</p>
          <ul>
            {daemonCredentials.map((credential) => (
              <li key={credential.credentialId}>
                <span>{credential.label ?? credential.credentialId.slice(0, 12)}</span>
                <Button
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void handleRemove(credential.credentialId)}
                  disabled={busy !== null}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {listError && (
        <div className="banner warning" role="status">
          {listError}
        </div>
      )}

      {error && (
        <div className="banner warning" role="alert">
          {error}
        </div>
      )}
    </SettingsBlock>
  );
}
