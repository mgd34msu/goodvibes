/**
 * Mail, the Mail tab of Personal: a two-pane inbox (messages left, the open
 * message right) with a compose panel that floats from the lower right, over
 * the daemon's `email.*` verbs: list (paged backwards with `before`), read,
 * mark read or unread, archive, delete (to the account's Trash), attachment
 * download, drafts (listed and reopened in the composer), save draft and send.
 *
 * This view is wiring over capability the daemon publishes, not an
 * integration: there is no
 * IMAP client, no SMTP client, no OAuth flow and no credential handling anywhere
 * in this file or anything it imports. Every call is `platform.operator.email.*`. The
 * browser never holds a mail credential because it never has one to hold.
 *
 * HONESTY CONTRACT (mail-refusal.ts owns the classification; three shapes, each
 * rendered distinctly, never folded into a generic "error"):
 *  1. NOT AVAILABLE, 404/501. This daemon build has no mail handler wired. The
 *     tab is one empty state: what is missing, what fixes it, one action. There
 *     is no form to fill in for a capability that cannot answer.
 *  2. NEEDS SETUP, a 412 precondition refusal. The handler exists; no account
 *     has been brought. Points at settings, which writes through the daemon.
 *  3. GENUINE ERROR, anything else, an empty state with retry.
 * There is deliberately no fourth "maybe it's just empty" reading. An inbox that
 * really is empty is a successful response with `messages: []`, and renders as
 * an empty state that says so, never as a refusal, and never the other way round.
 *
 * NEVER A DEAD BUTTON: while the surface is refusing, Compose does not render at
 * all, so nothing invites an action that cannot land.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Archive, FileText, Inbox, Mail, MailOpen, Pencil, RefreshCw, Reply, Trash2 } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { EmailDraftCreateInput, EmailSendInput, EmailUnreadableMessage } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { errorCode, formatError, isDaemonUnreachableError } from '../../lib/errors';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { useToast } from '../../lib/toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { DetailPane, EmptyState, ListDetail, SkeletonRows } from '../../components/data-view/DataView';
import { Button, Checkbox, IconButton, Row, RowList, Select, StatusDot } from '../../components/ui';
import { Chip } from '../../components/ui/Chip';
import { DateField } from '../../components/ui/DateField';
import { mailRefusalNote } from '../../lib/mail-refusal';
import { sortInboxMessagesByUidDescending } from '../../lib/mail-order';
import { PersonalPage } from '../personal/PersonalPage';
import { openSettingsSection } from '../personal/openSettings';
import { MailCompose, type MailComposeHandle } from './MailCompose';
import { MailMessageBody, useMailMessage, type MailMessageData } from './MailMessagePeek';
import { replySubjectLine } from '@goodvibes/engine/platform/platform/judgment-browser/catalogs';
import { getClientLifetime, isClientLifetimeCurrent, type ClientLifetime } from '../../lib/client-lifetime';
import { randomUuid } from '../../lib/uuid';
import '../../styles/components/mail.css';
import { whenLabel } from '../../lib/when-label';
import { nonEmpty } from '../../lib/non-empty';

const LIMIT_OPTIONS = [
  { value: '25', label: '25 messages' },
  { value: '50', label: '50 messages' },
  { value: '100', label: '100 messages' },
] as const;

/**
 * The messages the daemon could not parse, and why.
 *
 * Rendered rather than counted: "3 messages could not be read" tells an operator
 * nothing they can act on, while the per-message detail the daemon already sends
 * ("unsupported encoding", "malformed header") is the thing that says whether it
 * is one broken sender or a whole account misconfigured. `uid` is optional on the
 * wire, a message can fail before its uid is known, so it is only shown when
 * present rather than rendered as "undefined".
 */
function UnreadableNote({ items }: { items: readonly EmailUnreadableMessage[] }) {
  if (items.length === 0) return null;
  return (
    <div className="dv-notice dv-notice--warn mail-unreadable" role="status" data-testid="mail-unreadable">
      <AlertTriangle aria-hidden="true" />
      <div>
        <p className="mail-unreadable__title">
          {items.length === 1 ? '1 message could not be read' : `${String(items.length)} messages could not be read`}
        </p>
        <ul>
          {items.map((item, index) => (
            <li key={item.uid ?? `no-uid-${String(index)}`}>
              {item.uid === undefined ? item.detail : `uid ${String(item.uid)}: ${item.detail}`}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function normalizeRecipients(value: string): string {
  return value.split(',').map((part) => part.trim()).filter(Boolean).join(', ');
}

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : whenLabel(parsed.getTime()) || iso;
}

/** A compact date for a list row: the time today, the month and day otherwise. */
function formatShort(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const sameDay = parsed.toDateString() === new Date().toDateString();
  return sameDay
    ? parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The original under a reply, quoted the way mail programs do. */
function quotedReply(message: MailMessageData): string {
  const quoted = message.bodyText.replace(/\r\n/g, '\n').trimEnd().split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  return `\n\nOn ${formatWhen(message.date)}, ${message.from} wrote:\n${quoted}\n`;
}

/** Hand bytes to the browser as a file to save; never rendered in the page. */
function saveAttachment(filename: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  // octet-stream so the browser saves the file instead of opening whatever the sender attached.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'attachment';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A send whose answer never arrived may have gone; the same clientSendId makes a repeat safe. */
function sendOutcomeUnknown(error: unknown): boolean {
  return errorCode(error) === 'EMAIL_DELIVERY_UNCONFIRMED' || isDaemonUnreachableError(error);
}

const STALE_CONNECTION = 'The connection changed. Check the recipients and press Send again.';

interface ComposerSnapshot {
  readonly lifetime: ClientLifetime;
  readonly revision: number;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo: string;
}

export interface MailViewProps {
  /** The Personal tab switcher; shown first in the filter row. */
  tabs?: ReactNode;
}

export function MailView({ tabs }: MailViewProps = {}) {
  // Send and save-draft do not touch the inbox; save-draft refreshes the Drafts list
  // (an opened draft is replaced, never copied); mark, archive and delete change the
  // inbox and refresh the listing. Opening a message is a
  // BODY.PEEK read and leaves it unread until Mark read is pressed.
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [limit, setLimit] = useState('25');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [since, setSince] = useState('');
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);

  const [composeOpen, setComposeOpen] = useState(false);
  const composeRef = useRef<MailComposeHandle | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [inReplyTo, setInReplyTo] = useState('');
  // The saved draft the composer holds (opened from Drafts): saving replaces it, never adds a copy.
  const [editingDraft, setEditingDraft] = useState<{ readonly uid: number; readonly uidValidity: number } | null>(null);
  // What the composer was loaded with (a reply, a draft, or nothing): anything else in it is unsaved writing.
  const loadedComposer = useRef(JSON.stringify(['', '', '', '']));
  const composerLifetime = useRef<ClientLifetime | null>(null);
  const composerRevision = useRef(0);
  // One id per message as written: kept while the text is unchanged, so a repeated
  // Send (after a lost answer) is answered by the daemon with the first result.
  const sendId = useRef<{ readonly key: string; readonly id: string } | null>(null);
  // A confirmation sheet is open or a send is in flight. Enter in a field submits the
  // form even while Send is disabled; this only keeps a second sheet from opening.
  // Duplicate mail is prevented by the daemon, which answers a repeated clientSendId once.
  const sendInFlight = useRef(false);

  const inbox = useInfiniteQuery({
    queryKey: queryKeys.emailInbox(Number(limit), unreadOnly, since),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      platformClient.operator.email.inbox.list({
        limit: Number(limit),
        ...(unreadOnly ? { unreadOnly: true } : {}),
        // Noon UTC of the chosen day names that calendar day in every time zone; IMAP SINCE is a date.
        ...(since ? { since: `${since}T12:00:00.000Z` } : {}),
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.messages.length, 0);
      if (last.messages.length === 0 || loaded >= (pages[0]?.total ?? 0)) return undefined;
      return Math.min(...last.messages.map((message) => message.uid));
    },
  });
  // Each listed message carries the daemon's triage label (email.inbox.list joins
  // its inbox mirror by account and mailbox generation); normal mail has no mark.
  const labels = useMemo(() => {
    const byUid = new Map<number, 'spam' | 'priority'>();
    for (const page of inbox.data?.pages ?? []) {
      for (const message of page.messages) {
        if (message.triageLabel === 'spam' || message.triageLabel === 'priority') byUid.set(message.uid, message.triageLabel);
      }
    }
    return byUid;
  }, [inbox.data]);
  const detail = useMailMessage(selectedUid);
  // Drafts a page at a time, newest first: "Load older drafts" reads the page before the
  // oldest shown (by UID), so every draft in the folder is reachable here.
  const drafts = useInfiniteQuery({
    queryKey: ['email', 'drafts'] as const,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      // `before` is on email.drafts.list's schema; the generated input type gains it when the contract is regenerated.
      const input: NonNullable<Parameters<typeof platformClient.operator.email.drafts.list>[0]> & { readonly before?: number } = {
        limit: 50, ...(pageParam === undefined ? {} : { before: pageParam }),
      };
      return platformClient.operator.email.drafts.list(input);
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.drafts.length, 0);
      if (last.drafts.length === 0 || loaded >= (pages[0]?.total ?? 0)) return undefined;
      return Math.min(...last.drafts.map((draft) => draft.uid));
    },
    enabled: showDrafts,
  });
  const draftPages = drafts.data?.pages ?? [];
  const draftRows = draftPages.flatMap((page) => page.drafts.map((draft) => ({ draft, uidValidity: (page as { readonly uidValidity?: number }).uidValidity })));

  const update = useMutation({
    // The mailbox generation the message was read under goes with its uid: a reset mailbox refuses instead of changing another message.
    mutationFn: (input: { uid: number; uidValidity: number | undefined; action: 'seen' | 'unseen' | 'archive' | 'delete' }) => {
      if (input.uidValidity === undefined) {
        return Promise.reject(new Error('The mail server did not say which mailbox generation this message belongs to, so it cannot be changed safely from here. Change it in another mail client.'));
      }
      return platformClient.operator.email.inbox.update({ uid: input.uid, uidValidity: input.uidValidity, action: input.action } as Parameters<typeof platformClient.operator.email.inbox.update>[0]);
    },
    onSuccess: async (result) => {
      if (result.action === 'archive' || result.action === 'delete') {
        if (selectedUid === result.uid) setSelectedUid(null);
        toast({ title: result.action === 'archive' ? 'Archived' : 'Moved to Trash', description: result.movedTo ? `Now in ${result.movedTo}.` : undefined, tone: 'success' });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email', 'inbox'] }),
        queryClient.invalidateQueries({ queryKey: ['email', 'message'] }),
      ]);
    },
    onError: (error) => {
      // A refusal may mean the mailbox was reset: the open message is read again, so the next try carries the current generation.
      void queryClient.invalidateQueries({ queryKey: ['email', 'message'] });
      const note = mailRefusalNote(error);
      toast({ title: note?.title ?? 'The message was not changed', description: note?.description ?? formatError(error), tone: 'danger' });
    },
  });

  const attachment = useMutation({
    mutationFn: (input: { uid: number; index: number }) => platformClient.operator.email.attachment.get(input),
    onSuccess: (file) => saveAttachment(file.filename, file.contentBase64),
    onError: (error) => toast({ title: 'The attachment could not be downloaded', description: formatError(error), tone: 'danger' }),
  });

  const inboxNote = inbox.error ? mailRefusalNote(inbox.error) : null;
  // Sending follows the inbox's verdict: if listing is refused, sending is too (same
  // surface, same daemon state). A control whose availability is not yet known must
  // not look available, so Compose also waits for the first answer.
  const surfaceRefusing = Boolean(inboxNote) || inbox.isPending;

  const clearComposer = useCallback((): void => {
    composerLifetime.current = null;
    composerRevision.current++;
    sendId.current = null;
    setTo('');
    setSubject('');
    setBody('');
    setInReplyTo('');
    setEditingDraft(null);
    loadedComposer.current = JSON.stringify(['', '', '', '']);
    setComposeOpen(false);
  }, []);

  useEffect(() => () => { composerRevision.current++; }, []);

  function composerCurrent(snapshot: ComposerSnapshot): boolean {
    return composerLifetime.current === snapshot.lifetime && composerRevision.current === snapshot.revision
      && isClientLifetimeCurrent(snapshot.lifetime);
  }
  /**
   * The text as it is now, under the connection it was written for. A connection that
   * changed since (sign-in renewed, direct and relay route swapped) keeps the text,
   * re-arms the composer under the current connection and asks for one more press,
   * so nothing is sent through a connection the person did not review.
   */
  function captureComposer(): ComposerSnapshot | undefined {
    const lifetime = composerLifetime.current;
    if (!lifetime || !isClientLifetimeCurrent(lifetime)) {
      composerLifetime.current = getClientLifetime();
      composerRevision.current++;
      toast({ title: 'Not sent yet', description: STALE_CONNECTION, tone: 'warning' });
      return undefined;
    }
    return { lifetime, revision: composerRevision.current, to: normalizeRecipients(to), subject: subject.trim(), body, inReplyTo };
  }
  function assertComposerCurrent(snapshot: ComposerSnapshot): void {
    if (!composerCurrent(snapshot)) throw new Error(STALE_CONNECTION);
  }
  function clientSendIdFor(snapshot: ComposerSnapshot): string {
    const key = JSON.stringify([snapshot.to, snapshot.subject, snapshot.body, snapshot.inReplyTo]);
    if (sendId.current?.key !== key) sendId.current = { key, id: randomUuid() };
    return sendId.current.id;
  }

  const send = useMutation({
    mutationFn: (snapshot: ComposerSnapshot) => {
      assertComposerCurrent(snapshot);
      const input: EmailSendInput = {
        to: snapshot.to,
        subject: snapshot.subject,
        body: snapshot.body,
        // Literal true, and only reached after the confirmation sheet resolved, the
        // platform marks this verb dangerous and irreversible, so the flag is set because
        // the operator saw the recipients and agreed, never on their behalf.
        confirm: true,
        clientSendId: clientSendIdFor(snapshot),
        ...(snapshot.inReplyTo ? { inReplyTo: snapshot.inReplyTo } : {}),
      };
      return platformClient.operator.email.send(input);
    },
    onSuccess: (result, snapshot) => {
      if (composerCurrent(snapshot)) clearComposer();
      toast({ title: 'Message sent', description: `Sent ${formatWhen(result.sentAt)} · ${result.messageId}`, tone: 'success' });
    },
    onError: (error) => {
      if (sendOutcomeUnknown(error)) {
        toast({
          title: 'We could not confirm this was sent',
          description: 'It may have gone. Check the Sent folder; pressing Send again with the same text will not send it twice.',
          tone: 'warning',
        });
        return;
      }
      const note = mailRefusalNote(error);
      toast({ title: note?.title ?? 'Send failed', description: note?.description ?? formatError(error), tone: 'danger' });
    },
  });

  const saveDraft = useMutation({
    mutationFn: async (snapshot: ComposerSnapshot & { readonly draft: { readonly uid: number; readonly uidValidity: number } | null }) => {
      assertComposerCurrent(snapshot);
      const input: EmailDraftCreateInput = {
        to: snapshot.to,
        subject: snapshot.subject,
        body: snapshot.body,
        ...(snapshot.inReplyTo ? { inReplyTo: snapshot.inReplyTo, references: snapshot.inReplyTo } : {}),
      };
      // An opened draft is replaced in place; a new one is appended.
      if (snapshot.draft) {
        const replaced = await platformClient.operator.email.draft.update({ ...input, uid: snapshot.draft.uid, uidValidity: snapshot.draft.uidValidity });
        return { uid: replaced.uid, replaced: replaced.replaced as number | undefined };
      }
      const created = await platformClient.operator.email.draft.create(input);
      return { uid: created.uid, replaced: undefined as number | undefined };
    },
    onSuccess: async (result, snapshot) => {
      if (composerCurrent(snapshot)) clearComposer();
      toast({
        title: result.replaced === undefined ? 'Draft saved to the account' : 'Draft updated in the account',
        description: result.replaced === undefined
          ? `Appended to the IMAP Drafts folder${result.uid === undefined ? '' : ` as UID ${result.uid}`}. It is in the mailbox itself, so it is there in any mail client, not only here.`
          : `Replaced draft UID ${result.replaced}${result.uid === undefined ? '' : ` with UID ${result.uid}`}; the Drafts folder keeps one copy.`,
        tone: 'success',
      });
      // The Drafts list shows the saved copy, not the one it replaced.
      await queryClient.invalidateQueries({ queryKey: ['email', 'drafts'] });
    },
    onError: (error) => {
      const note = mailRefusalNote(error);
      toast({ title: note?.title ?? 'Draft failed', description: note?.description ?? formatError(error), tone: 'danger' });
    },
  });

  const messages = useMemo(() => inbox.data?.pages.flatMap((page) => page.messages), [inbox.data]);
  const total = inbox.data?.pages[0]?.total;
  // Ordered by `uid` (server-assigned) descending, NEVER by `date` (sender-written,
  // sorting on it would let a sender pin their message to the top with a far-future
  // Date: header). Full rationale in mail-order.ts; do not "simplify" this to `date`.
  const sorted = useMemo(() => sortInboxMessagesByUidDescending(messages ?? []), [messages]);
  // Messages the account returned but the daemon could not parse, each with its own
  // reason. The contract has always carried this list, and they are shown even when
  // every message in the window is unreadable, where the list would otherwise
  // report a normal empty inbox.
  const unreadable = useMemo(() => inbox.data?.pages.flatMap((page) => page.unreadable ?? []) ?? [], [inbox.data]);
  const selectedSummary = sorted.find((message) => message.uid === selectedUid);
  const openMessage = detail.data;

  const composerReady = to.trim() !== '' && subject.trim() !== '' && body.trim() !== '';

  /** Unsent, unsaved writing in the composer, which loading a reply or a draft would replace. */
  function composerHasUnsavedWriting(): boolean {
    if (!to.trim() && !subject.trim() && !body.trim()) return false;
    return JSON.stringify([to, subject, body, inReplyTo]) !== loadedComposer.current;
  }

  /** Replace the composer's text only when nothing unsaved is in it, or the person agrees to lose it. */
  async function mayReplaceComposer(what: string): Promise<boolean> {
    if (!composerHasUnsavedWriting()) return true;
    return confirm.ask({
      title: 'Replace the message you are writing?',
      description: `The message in the composer has not been sent or saved. Opening ${what} replaces it, and it cannot be brought back. Save it as a draft first to keep it.`,
      confirmLabel: 'Replace',
      tone: 'danger',
    });
  }

  async function startReply(message: MailMessageData): Promise<void> {
    if (!await mayReplaceComposer('the reply')) return;
    composerLifetime.current = getClientLifetime();
    composerRevision.current++;
    setTo(message.from);
    setSubject(replySubjectLine(message.subject));
    setInReplyTo(message.messageId);
    setBody(quotedReply(message));
    setEditingDraft(null);
    loadedComposer.current = JSON.stringify([message.from, replySubjectLine(message.subject), quotedReply(message), message.messageId]);
    setComposeOpen(true);
    // A repeated Reply clicked in the still-visible desktop drawer must return
    // keyboard ownership to the composer, even though the panel stays mounted.
    composeRef.current?.focus('body');
  }

  async function openDraft(draft: { uid: number; to: string; subject: string; body: string; inReplyTo: string }, uidValidity: number | undefined): Promise<void> {
    if (!await mayReplaceComposer('this draft')) return;
    composerLifetime.current = getClientLifetime();
    composerRevision.current++;
    setTo(draft.to);
    setSubject(draft.subject);
    setBody(draft.body);
    setInReplyTo(draft.inReplyTo);
    // Saving it replaces this draft; without the folder's generation it is saved as a new one instead of guessing.
    setEditingDraft(uidValidity === undefined ? null : { uid: draft.uid, uidValidity });
    loadedComposer.current = JSON.stringify([draft.to, draft.subject, draft.body, draft.inReplyTo]);
    setComposeOpen(true);
    composeRef.current?.focus('body');
  }

  function selectMessage(uid: number | null): void {
    setSelectedUid(uid);
  }

  async function submitSend(): Promise<void> {
    if (!composerReady || surfaceRefusing || sendInFlight.current) return;
    const snapshot = captureComposer();
    if (!snapshot) return;
    sendInFlight.current = true;
    let agreed = false;
    try {
      agreed = await confirm.ask({
        title: 'Send this message?',
        target: snapshot.to,
        description: 'It leaves the account right away and cannot be recalled.',
        confirmLabel: 'Send',
        tone: 'danger',
      });
    } catch (error) {
      sendInFlight.current = false;
      throw error;
    }
    if (agreed && composerCurrent(snapshot)) send.mutate(snapshot, { onSettled: () => { sendInFlight.current = false; } });
    else sendInFlight.current = false;
  }

  const filters = inboxNote ? undefined : (
    <>
      <Select
        value={limit}
        onChange={setLimit}
        options={LIMIT_OPTIONS}
        aria-label="Number of messages to fetch"
      />
      <DateField value={since} onChange={setSince} aria-label="Only messages on or after this date" />
      <Checkbox checked={unreadOnly} onChange={setUnreadOnly}>Unread only</Checkbox>
      <Button variant={showDrafts ? 'primary' : 'outline'} size="sm" icon={<FileText />} onClick={() => setShowDrafts((open) => !open)} aria-pressed={showDrafts}>
        Drafts
      </Button>
      <div className="dv-filters__end">
        <IconButton label="Refresh inbox" icon={<RefreshCw />} onClick={() => { void inbox.refetch(); void queryClient.invalidateQueries({ queryKey: ['email', 'message'] }); if (showDrafts) void drafts.refetch(); }} />
      </div>
    </>
  );

  const action = surfaceRefusing
    ? undefined
    : (
      <Button
        variant="primary"
        icon={<Pencil />}
        onClick={() => {
          composerLifetime.current = getClientLifetime();
          composerRevision.current++;
          if (!composeOpen) setComposeOpen(true);
          composeRef.current?.focus(to.trim() ? 'body' : 'to');
        }}
      >
        Compose
      </Button>
    );

  let content: ReactNode;
  if (showDrafts && !inboxNote) {
    content = drafts.isPending ? <SkeletonRows count={4} label="Loading drafts" />
      : drafts.error ? (
        <EmptyState icon={<AlertCircle />} title="Drafts failed to load" role="status"
          action={<Button variant="outline" onClick={() => void drafts.refetch()}>Try again</Button>}>
          {mailRefusalNote(drafts.error)?.description ?? formatError(drafts.error)}
        </EmptyState>
      ) : draftRows.length === 0 ? (
        <EmptyState icon={<FileText />} title="No drafts">Drafts saved to the account appear here and open in the composer.</EmptyState>
      ) : (
        <div data-testid="mail-drafts">
          <p className="mail-count">Showing {draftRows.length} of {draftPages[0]?.total} drafts in {draftPages[0]?.mailbox}.</p>
          <RowList aria-label="Drafts">
            {draftRows.map(({ draft, uidValidity }) => (
              <Row
                key={draft.uid}
                className="mail-row"
                title={draft.subject || '(no subject)'}
                meta={`${draft.to || '(no recipient)'} · ${draft.body.slice(0, 120)}`}
                onSelect={() => void openDraft(draft, uidValidity)}
                trailing={<span className="mail-row__date">{formatShort(draft.date)}</span>}
              />
            ))}
          </RowList>
          {drafts.hasNextPage ? (
            <Button variant="outline" size="sm" onClick={() => void drafts.fetchNextPage()} disabled={drafts.isFetchingNextPage}>
              {drafts.isFetchingNextPage ? 'Loading…' : 'Load older drafts'}
            </Button>
          ) : null}
        </div>
      );
  } else if (inbox.isPending) {
    content = <SkeletonRows count={6} label="Loading inbox" />;
  } else if (inboxNote) {
    const notAvailable = inboxNote.kind === 'not-available';
    content = (
      <div data-testid={`mail-note-${inboxNote.kind}`}>
        <EmptyState
          icon={<Mail />}
          title={notAvailable ? 'Mail isn’t connected yet' : inboxNote.title}
          role="status"
          action={notAvailable
            ? <Button variant="outline" onClick={() => openSettingsSection('about')}>Update daemon</Button>
            : <Button variant="outline" onClick={() => openSettingsSection('account')}>Open settings</Button>}
        >
          {notAvailable
            ? 'This daemon doesn’t serve mail. Updating the daemon adds it, and your inbox shows up here with nothing else to set up.'
            : inboxNote.description}
        </EmptyState>
      </div>
    );
  } else if (inbox.error) {
    content = (
      <EmptyState
        icon={<AlertCircle />}
        title="Inbox failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void inbox.refetch()}>Try again</Button>}
      >
        {formatError(inbox.error)}
      </EmptyState>
    );
  } else if (sorted.length === 0) {
    content = (
      <>
        <EmptyState
          icon={<Inbox />}
          title={unreadable.length > 0 ? 'Nothing readable in the inbox' : 'Nothing in the inbox'}
        >
          {unreadable.length > 0
            ? 'Every message in this window failed to parse. They are listed below with the reason each one gave.'
            : unreadOnly
              ? 'No unread messages match this window. Clear the unread filter to see the rest.'
              : 'The account answered normally with no messages in this window.'}
        </EmptyState>
        <UnreadableNote items={unreadable} />
      </>
    );
  } else {
    const list = (
      <div data-testid="mail-list">
        <p className="mail-count">
          Showing {sorted.length} of {total ?? sorted.length} messages the account reported.
        </p>
        <UnreadableNote items={unreadable} />
        <RowList aria-label="Inbox">
          {sorted.map((message) => (
            <Row
              key={message.uid}
              className={message.unread ? 'mail-row mail-row--unread' : 'mail-row'}
              leading={<span className="mail-row__lead">{message.unread ? <StatusDot tone="info" srLabel="Unread" /> : null}</span>}
              title={message.subject || '(no subject)'}
              meta={`${message.from} · ${message.bodyPreview}`}
              selected={message.uid === selectedUid}
              onSelect={() => selectMessage(message.uid)}
              trailing={<>
                {labels.get(message.uid) === 'spam' ? <Chip size="sm" tone="warn">Spam</Chip> : null}
                {labels.get(message.uid) === 'priority' ? <Chip size="sm" tone="info">Priority</Chip> : null}
                {message.screening === 'not-screened'
                  ? <Chip size="sm" title={message.screeningReason ?? 'Only code checked this message for credential and card text.'}>Not screened</Chip>
                  : null}
                <span className="mail-row__date">{formatShort(message.date)}</span>
              </>}
            />
          ))}
        </RowList>
        {inbox.hasNextPage ? (
          <Button variant="outline" size="sm" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
          </Button>
        ) : null}
      </div>
    );
    content = (
      <ListDetail
        mode="peek"
        list={list}
        detailOpen={selectedUid !== null}
        onCloseDetail={() => selectMessage(null)}
        listLabel="Inbox"
        detailLabel="Message"
        backLabel="Inbox"
        detail={(
          <DetailPane
            title={nonEmpty(detail.data?.subject) ?? (detail.isPending ? 'Message' : '(no subject)')}
            meta={detail.data ? `${detail.data.from} · ${formatWhen(detail.data.date)}` : undefined}
            actions={openMessage ? (
              <>
                <Button variant="outline" size="sm" icon={<Reply />} onClick={() => void startReply(openMessage)}>
                  Reply
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<MailOpen />}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ uid: openMessage.uid, uidValidity: (openMessage as { readonly uidValidity?: number }).uidValidity, action: selectedSummary?.unread === false ? 'unseen' : 'seen' })}
                >
                  {selectedSummary?.unread === false ? 'Mark unread' : 'Mark read'}
                </Button>
                <IconButton label="Archive" icon={<Archive />} disabled={update.isPending}
                  onClick={() => update.mutate({ uid: openMessage.uid, uidValidity: (openMessage as { readonly uidValidity?: number }).uidValidity, action: 'archive' })} />
                <IconButton label="Delete (moves to Trash)" icon={<Trash2 />} disabled={update.isPending}
                  onClick={() => update.mutate({ uid: openMessage.uid, uidValidity: (openMessage as { readonly uidValidity?: number }).uidValidity, action: 'delete' })} />
              </>
            ) : undefined}
            onClose={() => selectMessage(null)}
            closeLabel="Close message"
          >
            <MailMessageBody
              detail={detail}
              onDownload={(index) => { if (openMessage) attachment.mutate({ uid: openMessage.uid, index }); }}
              downloading={attachment.isPending}
            />
          </DetailPane>
        )}
      />
    );
  }

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <EmptyState icon={<AlertCircle />} title="Mail view failed" action={<Button variant="outline" onClick={reset}>Try again</Button>}>
          {formatError(err)}
        </EmptyState>
      )}
    >
      <div className="mail-view" data-testid="mail-view">
        <PersonalPage tabs={tabs} filters={filters} action={action}>
          {content}
        </PersonalPage>
        {composeOpen && !surfaceRefusing ? (
          <MailCompose
            ref={composeRef}
            to={to}
            subject={subject}
            body={body}
            inReplyTo={inReplyTo}
            onToChange={(value) => { composerRevision.current++; setTo(value); }}
            onSubjectChange={(value) => { composerRevision.current++; setSubject(value); }}
            onBodyChange={(value) => { composerRevision.current++; setBody(value); }}
            onClearReply={() => { composerRevision.current++; setInReplyTo(''); }}
            onSend={() => void submitSend()}
            onSaveDraft={() => { if (!composerReady || surfaceRefusing || saveDraft.isPending) return; const snapshot = captureComposer(); if (snapshot) saveDraft.mutate({ ...snapshot, draft: editingDraft }); }}
            onClose={() => { composerRevision.current++; setComposeOpen(false); }}
            ready={composerReady}
            sending={send.isPending}
            saving={saveDraft.isPending}
          />
        ) : null}
        {confirm.element}
      </div>
    </ErrorBoundary>
  );
}
