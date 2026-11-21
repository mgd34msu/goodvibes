/**
 * The reply a request got, shown with the request: read once, when the reply
 * has finished, from the hosted session's transcript (`sessions.hosted.history`,
 * which needs no live attachment and also answers for an ended session).
 */
import { useQuery } from "@tanstack/react-query";
import { client as platformClient } from "../../lib/goodvibes";
import { formatError } from "../../lib/errors";
import { asRecord, firstString } from "../../lib/object";
import { MarkdownMessage } from "../../components/MarkdownMessage";
import { DetailSection } from "../../components/data-view/DataView";

interface FoundReply {
  readonly content: string;
  /** True when the row names this request; false when the transcript names no request at all and this is only its newest reply. */
  readonly attributed: boolean;
}

/**
 * The last assistant row the turn `turnKey` wrote. A transcript saved before
 * rows named their request carries no correlation id on any row; then the
 * newest reply is returned, marked as not attributed.
 */
function replyFor(value: unknown, turnKey: string): FoundReply | undefined {
  const history = asRecord(value).history;
  if (!Array.isArray(history)) return undefined;
  let newest: string | undefined;
  let anyAttributed = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    const correlationId = firstString(row, ["correlationId"]);
    if (correlationId) anyAttributed = true;
    if (firstString(row, ["role"]) !== "assistant" || !firstString(row, ["content"]).trim()) continue;
    if (correlationId === turnKey) return { content: firstString(row, ["content"]), attributed: true };
    newest ??= firstString(row, ["content"]);
  }
  return !anyAttributed && newest !== undefined ? { content: newest, attributed: false } : undefined;
}

/** `turnKey` names the finished turn (its correlation id), so each reply of a session is read once. */
export function NativeReply({ sessionId, turnKey }: { sessionId: string; turnKey: string }) {
  const history = useQuery({
    queryKey: ["hosted-session-history", sessionId, turnKey],
    queryFn: ({ signal }) => platformClient.operator.sessions.hosted.history(sessionId, signal),
    staleTime: Infinity,
    retry: false,
  });
  const reply = replyFor(history.data, turnKey);
  if (history.isPending) return null;
  if (history.isError) return <p className="dv-muted" role="note">The reply could not be read here: {formatError(history.error)}</p>;
  if (!reply) return null;
  return (
    <DetailSection title={reply.attributed ? "Reply" : "Newest reply in this session"}>
      <div className="lib-markdown"><MarkdownMessage content={reply.content} /></div>
    </DetailSection>
  );
}
