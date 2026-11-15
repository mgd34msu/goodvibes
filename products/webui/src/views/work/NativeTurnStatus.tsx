import type { NativeTurnObservation } from "../../lib/native-turn";
import { DetailSection, Facts } from "../../components/data-view/DataView";

/**
 * The reply's identifiers, for the Details disclosure. The status line and the
 * one action a person may need live with the request, not here.
 */
export function NativeTurnStatus({ observation }: { observation?: NativeTurnObservation }) {
  if (!observation || observation.kind === "not-requested") return null;
  const snapshot = observation.kind === "recorded" ? observation.snapshot : undefined;
  return (
    <DetailSection title="Reply">
      <Facts
        items={[
          { label: "State", value: snapshot?.state ?? "The daemon has no record of this reply starting" },
          { label: "Source revision", value: observation.target.sourceRevision },
          ...(snapshot
            ? [
                { label: "Session", value: snapshot.sessionId ?? "Not recorded" },
                { label: "Broker input", value: snapshot.brokerInputId ?? "Not recorded" },
                { label: "Correlation", value: snapshot.correlationId ?? "Not recorded" },
              ]
            : []),
        ]}
      />
    </DetailSection>
  );
}
