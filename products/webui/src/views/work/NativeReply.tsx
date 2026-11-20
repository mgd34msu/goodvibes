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

/** The last thing the assistant said in the transcript: the reply to the newest request. */
function lastReply(value: unknown): string {
  const history = asRecord(value).history;
  if (!Array.isArray(history)) return "";
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (firstString(row, ["role"]) === "assistant" && firstString(row, ["content"]).trim()) return firstString(row, ["content"]);
  }
  return "";
}

/** `turnKey` names the finished turn (its correlation id), so each reply of a session is read once. */
export function NativeReply({ sessionId, turnKey }: { sessionId: string; turnKey: string }) {
  const history = useQuery({
    queryKey: ["hosted-session-history", sessionId, turnKey],
    queryFn: ({ signal }) => platformClient.operator.sessions.hosted.history(sessionId, signal),
    staleTime: Infinity,
    retry: false,
  });
  const reply = lastReply(history.data);
  if (history.isPending) return null;
  if (history.isError) return <p className="dv-muted" role="note">The reply could not be read here: {formatError(history.error)}</p>;
  if (!reply) return null;
  return (
    <DetailSection title="Reply">
      <div className="lib-markdown"><MarkdownMessage content={reply} /></div>
    </DetailSection>
  );
}
