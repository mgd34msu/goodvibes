import { useCallback, useEffect, useRef, useState } from 'react';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { SettingsBlock } from './dialog/parts';

/**
 * Delegated Telegram intake: a selected chat's messages wait for the owner
 * instead of being answered. Each command is one inbound.telegram.* verb on
 * the daemon, which owns every fact shown here; a held answer is shown with
 * its reason and next step.
 */

interface SourceRef {
  readonly sessionId: string;
  readonly inputId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly requestId: string;
}

interface ReviewRecord {
  readonly id: string;
  readonly ref: SourceRef;
  readonly approvalId: string;
  readonly acceptedAt: number;
  readonly sourceExpiresAt: number;
  readonly recordExpiresAt: number;
  readonly state: 'accepted-for-review' | 'reviewed' | 'cancelled';
}

interface PendingMessage {
  readonly ref: SourceRef;
  readonly approvalId: string;
  readonly sourceExpiresAt: number;
  readonly outcome: string;
}

interface IntakeList {
  readonly records: readonly ReviewRecord[];
  readonly pending: readonly PendingMessage[];
}

/** Any command's answer: its outcome, plus a hold's reason, sentence and next step. */
interface CommandResult {
  readonly outcome: string;
  readonly message?: string;
  readonly nextStep?: string;
  readonly configurationId?: string;
  readonly expiresAt?: number;
  readonly accountIdentity?: { readonly id: string; readonly username: string };
  readonly original?: { readonly text: string; readonly unsupportedSources: readonly { readonly kind: string; readonly label: string }[] };
}

type IntakeOperation = 'configure' | 'decide' | 'read' | 'cancel' | 'revoke' | 'release';

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

// The verbs' outputs are zod unions in the contract; this view reads only the
// fields above, so it takes them through these narrow shapes.
async function invoke(operation: IntakeOperation | 'list', input: Record<string, unknown>): Promise<unknown> {
  return await platformClient.operator.invoke(`inbound.telegram.${operation}` as 'inbound.telegram.list', input as never);
}

function holdText(result: CommandResult): string {
  const account = result.accountIdentity ? ` The verified bot is @${result.accountIdentity.username} (${result.accountIdentity.id}).` : '';
  return `${result.message ?? 'Held.'}${account}${result.nextStep ? ` Next: ${result.nextStep}` : ''}`;
}

function parseChat(value: string): { chatId: string; threadId?: string } | null {
  const [chatId, threadId, extra] = value.trim().split('/');
  if (!chatId || extra !== undefined || threadId === '') return null;
  return threadId === undefined ? { chatId } : { chatId, threadId };
}

export function TelegramDelegatedIntake() {
  const [list, setList] = useState<IntakeList | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [original, setOriginal] = useState<{ id: string; text: string; notShown: string[] } | null>(null);
  const [chat, setChat] = useState('');
  const [bot, setBot] = useState('');
  const [configurationId, setConfigurationId] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke('list', {}) as IntakeList;
      if (mounted.current) setList(result);
    } catch (error) {
      if (mounted.current) setMessage(formatError(error));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (operation: IntakeOperation, input: Record<string, unknown>, done: (result: CommandResult) => string) => {
    if (pending) return;
    setPending(true); setMessage('');
    try {
      const result = await invoke(operation, input) as CommandResult;
      if (!mounted.current) return;
      setMessage(result.outcome === 'held' ? holdText(result) : done(result));
      await refresh();
    } catch (error) {
      if (mounted.current) setMessage(formatError(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const configure = () => {
    const target = parseChat(chat);
    if (!target || !bot.trim()) { setMessage('Enter the chat id (chatId or chatId/threadId) and the bot username or id.'); return; }
    void run('configure', {
      ...target, accountId: bot.trim(), pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: HOUR_MS,
      configurationLifetimeMs: WEEK_MS, onExpiry: 'release-original-and-hold',
    }, (result) => {
      if (result.configurationId) setConfigurationId(result.configurationId);
      return `The chat is selected${result.accountIdentity ? ` on @${result.accountIdentity.username}` : ''} until ${result.expiresAt ? new Date(result.expiresAt).toLocaleString() : 'its configuration ends'}. Each message waits for your decision; the chat is not answered normally until you release it.`;
    });
  };

  const release = () => {
    const target = parseChat(chat);
    if (!target) { setMessage('Enter the chat id to release (chatId or chatId/threadId).'); return; }
    void run('release', target, () => 'The chat is back to normal handling.');
  };

  const revoke = () => {
    if (!configurationId) return;
    void run('revoke', { configurationId }, () => 'No new message is captured. The chat stays held until you release it.');
  };

  const decide = (entry: PendingMessage, approved: boolean) => {
    void run('decide', {
      approvalId: entry.approvalId, ref: entry.ref, approved,
      ...(approved ? { choices: {
        processingPurpose: 'accept-external-message-for-owner-review',
        sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: HOUR_MS,
        derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: WEEK_MS,
        execution: 'none', ownerMayReadOriginal: true,
      } } : {}),
    }, (result) => result.outcome === 'denied' ? 'Denied; its original was released and nothing was run.' : 'Approved for review; nothing was run. Read it from the review queue.');
  };

  const read = (record: ReviewRecord) => {
    void run('read', { ref: record.ref }, (result) => {
      if (result.original) {
        setOriginal({ id: record.id, text: result.original.text, notShown: result.original.unsupportedSources.map((entry) => `${entry.kind} ${entry.label}`) });
        return 'Marked as read.';
      }
      setOriginal(null);
      return 'Its original is no longer in memory; ask the sender to send it again if it still needs review.';
    });
  };

  const cancel = (ref: SourceRef) => {
    void run('cancel', { ref }, () => 'Closed; its original was released.');
  };

  return <SettingsBlock title="Telegram delegated intake" description="Select a Telegram chat whose messages should wait for you instead of being answered. You approve or deny each message, read the approved ones here, and release the chat to return it to normal handling. Nothing a message asks for is run.">
    <Field label="Chat" help="chatId, or chatId/threadId for one topic">
      <Input value={chat} onChange={(event) => setChat(event.currentTarget.value)} placeholder="-1001234567890" />
    </Field>
    <Field label="Bot" help="The bot's username or id">
      <Input value={bot} onChange={(event) => setBot(event.currentTarget.value)} placeholder="@my_bot" />
    </Field>
    <div>
      <Button size="sm" disabled={pending} onClick={configure}>Hold this chat for review</Button>{' '}
      <Button size="sm" variant="ghost" disabled={pending} onClick={release}>Release this chat</Button>{' '}
      {configurationId && <Button size="sm" variant="ghost" disabled={pending} onClick={revoke}>Stop capturing</Button>}{' '}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => { void refresh(); }}>Refresh</Button>
    </div>
    {list && list.pending.length === 0 && list.records.length === 0 && <p role="status">Nothing waits for you and the review queue is empty.</p>}
    {list && list.pending.length > 0 && <div>
      <p>Waiting for your decision</p>
      <ul>
        {list.pending.map((entry) => <li key={entry.approvalId}>
          {entry.outcome === 'awaiting-owner' ? 'Waiting' : entry.outcome} · original kept until {new Date(entry.sourceExpiresAt).toLocaleString()}{' '}
          {entry.outcome === 'awaiting-owner' && <>
            <Button size="sm" disabled={pending} onClick={() => decide(entry, true)}>Approve for review</Button>{' '}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(entry, false)}>Deny</Button>{' '}
          </>}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => cancel(entry.ref)}>Withdraw</Button>
        </li>)}
      </ul>
    </div>}
    {list && list.records.length > 0 && <div>
      <p>Review queue</p>
      <ul>
        {list.records.map((record) => <li key={record.id}>
          Approved {new Date(record.acceptedAt).toLocaleString()} · {record.state === 'reviewed' ? 'read' : 'not read yet'} · {record.sourceExpiresAt > Date.now() ? `original kept until ${new Date(record.sourceExpiresAt).toLocaleString()}` : 'original released'}{' '}
          <Button size="sm" disabled={pending} onClick={() => read(record)}>Read</Button>{' '}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => cancel(record.ref)}>Close</Button>
          {original?.id === record.id && <div>
            <pre className="work-prose">{original.text}</pre>
            {original.notShown.map((entry) => <p key={entry}>Not shown: {entry}</p>)}
          </div>}
        </li>)}
      </ul>
    </div>}
    {message && <p role="status">{message}</p>}
  </SettingsBlock>;
}
