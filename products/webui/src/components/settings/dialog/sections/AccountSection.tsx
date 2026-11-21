/**
 * Account: everything that was Admin's sign-in half. Session login, the
 * explicit operator token, the current sign-in as readable fields (raw JSON
 * behind "Show details"), passkey step-up, the owner profile and the mail and
 * calendar account status, then the profile / email / calendar config groups.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GOODVIBES_BASE_URL,
  getCurrentAuth,
  invokeMethod,
  login,
  setExplicitAuthToken,
} from '../../../../lib/goodvibes';
import { isDifferentOrigin, parseScannedPairing, type ScannedPairing } from '../../../../lib/pairing-qr';
import { useSignOut } from '../../../../hooks/useSignOut';
import { queryKeys } from '../../../../lib/queries';
import { compactJson } from '../../../../lib/object';
import { errorDebugValue, formatError } from '../../../../lib/errors';
import { ErrorState } from '../../../feedback/ErrorState';
import { SkeletonBlock } from '../../../feedback/SkeletonBlock';
import { Button } from '../../../ui/Button';
import { Field, Input } from '../../../ui/Field';
import { StepUpSettings } from '../../StepUpSettings';
import { OwnerProfileSettings } from '../../OwnerProfileSettings';
import { MailAccountSettings } from '../../MailAccountSettings';
import { ConfigGroupList, useConfigSettings } from '../ConfigSettings';
import { ReadableValue, SettingsBlock, ShowDetails } from '../parts';
import { groupsForSection } from '../sections';

/**
 * The sign-in code in what was pasted: `goodvibes pair` prints a link carrying it, and a
 * QR's JSON payload can be pasted too, so the text is read as a pairing payload first and
 * is a bare code only when it is not one. A link for another daemon is refused by name:
 * a credential goes only to the daemon it was issued for.
 */
function signInCodeFromPaste(text: string): string {
  let parsed: ScannedPairing;
  try {
    parsed = parseScannedPairing(text);
  } catch {
    return text;
  }
  if (parsed.kind === 'relay') throw new Error('That is a relay code, not a sign-in code');
  if (parsed.kind === 'password') throw new Error('That carries a username and password; enter them under Sign in above');
  if (parsed.url && isDifferentOrigin(parsed.url, GOODVIBES_BASE_URL)) {
    throw new Error(`That link is for GoodVibes at ${new URL(parsed.url).origin}, and this page is at ${GOODVIBES_BASE_URL}; it was not sent here. Open it there instead`);
  }
  return parsed.token;
}

export function AccountSection() {
  const queryClient = useQueryClient();
  const { groups } = useConfigSettings();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');

  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: getCurrentAuth });
  const localAuth = useQuery({ queryKey: queryKeys.localAuth, queryFn: () => invokeMethod('local_auth.status') });

  const loginMutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries();
    },
  });
  const { signOut } = useSignOut();
  const [signingOut, setSigningOut] = useState(false);
  const tokenMutation = useMutation({
    mutationFn: () => setExplicitAuthToken(signInCodeFromPaste(token.trim())),
    onSuccess: async () => {
      setToken('');
      await queryClient.invalidateQueries();
    },
  });
  // The app's one sign-out (hooks/useSignOut): it ends the daemon session and the relay
  // pairing, and the signed-out gate that replaces this dialog shows a failure with its retry.
  function handleSignOut() {
    setSigningOut(true);
    void signOut().finally(() => setSigningOut(false));
  }

  const loginDiagnostics = {
    route: 'POST /api/browser-session (over the relay: POST /login, kept in memory)',
    transport: 'raw fetch; the daemon answers with an HttpOnly cookie, never the token',
    currentAuth: auth.data,
    currentAuthError: errorDebugValue(auth.error),
    localAuth: localAuth.data,
    localAuthError: errorDebugValue(localAuth.error),
    loginError: errorDebugValue(loginMutation.error),
  };

  function submitLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username && password) loginMutation.mutate();
  }

  function submitToken(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token.trim()) tokenMutation.mutate();
  }

  return (
    <>
      <SettingsBlock
        title="Current sign-in"
        description={(
          <>
            Your daemon owns sign-in. This browser holds it in a cookie no page script can read; over the
            relay it is held in memory only, until the page reloads.
          </>
        )}
      >
        {auth.isPending ? (
          <div className="settings-skeleton" aria-label="Loading auth status">
            <SkeletonBlock height={16} width="60%" />
            <SkeletonBlock variant="text" lines={3} />
          </div>
        ) : auth.error ? (
          <ErrorState error={auth.error} onRetry={() => auth.refetch()} title="Auth status unavailable" />
        ) : (
          <ReadableValue value={auth.data} title="Current Auth" />
        )}
      </SettingsBlock>

      <SettingsBlock
        title="Sign in"
        description="Sign in with your daemon username and password. This browser keeps only its own session."
      >
        <form className="settings-form" onSubmit={submitLogin}>
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
          <div className="settings-actions">
            <Button variant="primary" type="submit" disabled={loginMutation.isPending || !username || !password}>
              Sign in
            </Button>
          </div>
        </form>
        {loginMutation.error && <div className="banner warning">{formatError(loginMutation.error)}</div>}
        <ShowDetails label="Show login diagnostics">
          <pre className="settings-pre">{compactJson(loginDiagnostics)}</pre>
        </ShowDetails>
      </SettingsBlock>

      <SettingsBlock
        title="Operator token"
        description={<>Paste a token deliberately. The daemon checks it before this browser uses it; a refused token changes nothing.</>}
      >
        <form className="settings-form" onSubmit={submitToken}>
          <Field label="Operator token">
            <Input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Paste a token, or the link or code goodvibes pair prints"
            />
          </Field>
          <div className="settings-actions">
            <Button disabled={signingOut} onClick={handleSignOut}>
              Sign out
            </Button>
            <Button type="submit" disabled={tokenMutation.isPending || !token.trim()}>
              Validate and store
            </Button>
          </div>
        </form>
        {tokenMutation.error && <div className="banner warning">{formatError(tokenMutation.error)}</div>}
      </SettingsBlock>

      <StepUpSettings />
      <OwnerProfileSettings />
      <MailAccountSettings />
      <ConfigGroupList groups={groupsForSection('account', groups)} />
    </>
  );
}
