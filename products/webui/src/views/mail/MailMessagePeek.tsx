/**
 * The message detail for a selected inbox row. Reads `email.inbox.read`, which
 * carries what the summary row cannot: the full body text and attachment
 * metadata. A genuine detail fetch, the same relationship the calendar event
 * detail has to the event list. The caller owns the query (so the pane header
 * can show the subject and sender) and hands it to MailMessageBody.
 *
 * TWO DELIBERATE RESTRAINTS, both about not doing more than the surface should:
 *
 * 1. `bodyHtml` is NEVER rendered. The detail schema carries it and this
 *    component reads it, but only to say that an HTML alternative exists, the
 *    text part is what gets displayed. Rendering an arbitrary sender's HTML
 *    inside the operator console would let mail from anyone style, lay out, and
 *    (via remote image loads) phone home from a page that also holds the daemon
 *    session. Showing bodyText and naming the HTML part is the honest version:
 *    nothing is hidden from the operator, and nothing a stranger wrote gets to
 *    run in here.
 *
 * 2. Attachments are downloaded, never rendered. Each one has a Download button
 *    (`email.attachment.get`); the bytes are saved as a file by the browser and
 *    nothing a sender attached is opened inside this page.
 *
 * The read verb is non-mutating on the server (BODY.PEEK), so opening a message
 * leaves it unread; the pane's Mark read button is the explicit change.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AlertCircle, Mail } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { mailRefusalNote } from '../../lib/mail-refusal';
import { Button } from '../../components/ui';
import { Download } from 'lucide-react';
import { DetailSection, EmptyState, Facts, SkeletonRows } from '../../components/data-view/DataView';

export type MailMessageData = Awaited<ReturnType<typeof platformClient.operator.email.inbox.read>>;

export function useMailMessage(uid: number | null): UseQueryResult<MailMessageData> {
  return useQuery({
    queryKey: queryKeys.emailMessage(uid ?? -1),
    enabled: uid !== null && Number.isFinite(uid),
    queryFn: () => platformClient.operator.email.inbox.read(uid ?? -1),
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MailMessageBody({ detail, onDownload, downloading = false }: {
  detail: UseQueryResult<MailMessageData>;
  /** Save the attachment at this position as a file. */
  onDownload?: (index: number) => void;
  downloading?: boolean;
}) {
  if (detail.isPending) return <SkeletonRows count={3} label="Loading message" />;

  if (detail.error) {
    const note = mailRefusalNote(detail.error);
    return (
      <EmptyState
        icon={note ? <Mail /> : <AlertCircle />}
        title={note?.title ?? 'Message failed to load'}
        role="status"
        action={note ? undefined : <Button variant="outline" onClick={() => void detail.refetch()}>Try again</Button>}
      >
        {note?.description ?? formatError(detail.error)}
      </EmptyState>
    );
  }

  const message = detail.data;
  const attachments = message.attachments ?? [];

  return (
    <div className="mail-detail" data-testid="mail-message-detail">
      <pre className="mail-detail__text">{message.bodyText}</pre>

      {message.bodyUnavailable && message.bodyUnavailable.length > 0 ? (
        <p className="mail-detail__note" role="status">
          {`Part of this message's text could not be fetched (${message.bodyUnavailable.map((entry) => entry.reason).join('; ')}). `}
          <Button variant="ghost" size="sm" onClick={() => void detail.refetch()}>Read it again</Button>
        </p>
      ) : null}

      {message.bodyHtml ? (
        <p className="mail-detail__note">
          This message also has an HTML part. The plain-text part is shown above. The console does not render
          sender HTML, so nothing from the message can style or load anything inside this page.
        </p>
      ) : null}

      {attachments.length > 0 ? (
        <DetailSection title={`Attachments (${attachments.length})`}>
          <Facts
            items={attachments.map((attachment, index) => ({
              label: attachment.filename || `Attachment ${index + 1}`,
              value: (
                <>
                  {`${attachment.contentType} · ${formatBytes(attachment.sizeBytes)} `}
                  {onDownload ? (
                    <Button variant="ghost" size="sm" icon={<Download />} disabled={downloading} onClick={() => onDownload(index)}>
                      Download
                    </Button>
                  ) : null}
                </>
              ),
            }))}
          />
          <p className="mail-detail__note">
            Downloads are saved as files. Nothing attached is opened inside this page.
          </p>
        </DetailSection>
      ) : null}

      <p className="mail-detail__uid">UID: {message.uid}</p>
    </div>
  );
}
