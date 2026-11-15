import type { NativeWorkExecutionRevision } from "@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import { DetailSection, Facts } from "../../components/data-view/DataView";

function revision(value: NativeWorkExecutionRevision | null): string {
  return value
    ? `Work ${value.work}, criteria ${value.criteria}, attempt ${value.attempt}`
    : "Unavailable";
}

/**
 * The work's identifiers and counts, for the Details disclosure. The status line
 * and the one action a person may need live with the request, not here.
 */
export function NativeExecutionStatus({ observation }: { observation?: NativeExecutionObservation }) {
  if (!observation || observation.kind === "not-requested") return null;
  const snapshot = observation.kind === "recorded" ? observation.snapshot : undefined;
  const execution = snapshot?.kind === "execution" ? snapshot : undefined;
  const settlement = execution?.settlement;
  return (
    <DetailSection title="Work">
      <Facts
        items={[
          { label: "Work", value: observation.target.workId },
          { label: "Attempt", value: observation.target.attemptId },
          { label: "Requested revisions", value: revision(observation.target.expectedRevision) },
          ...(snapshot
            ? [
                { label: "State", value: `${snapshot.kind}, ${snapshot.state}` },
                { label: "Recovery", value: snapshot.recovery },
                { label: "Current revisions", value: revision(snapshot.currentRevision) },
                { label: "Still the current attempt", value: snapshot.currentAttempt && !snapshot.stale ? "Yes" : "No" },
              ]
            : [{ label: "State", value: "The daemon has no record of this work starting" }]),
          ...(execution?.receipt
            ? [
                { label: "Contract", value: execution.receipt.contractId },
                { label: "Owner agent", value: execution.receipt.ownerAgentId },
              ]
            : []),
          ...(execution?.progress
            ? [
                { label: "Runner", value: execution.progress.status },
                { label: "Stage", value: execution.progress.stage ?? "None reported" },
                {
                  label: "Steps",
                  value: `${execution.progress.units.passed} passed, ${execution.progress.units.failed} failed, ${execution.progress.units.total} total`,
                },
                {
                  label: "Criteria",
                  value: `${execution.progress.criteria.met} met, ${execution.progress.criteria.unmet} unmet, ${execution.progress.criteria.unshown} not shown, ${execution.progress.criteria.total} total`,
                },
              ]
            : []),
          ...(settlement
            ? [
                { label: "Result check", value: settlement.reason ? `${settlement.state} (${settlement.reason})` : settlement.state },
                ...(settlement.evidenceId === undefined ? [] : [{ label: "Evidence", value: settlement.evidenceId }]),
              ]
            : []),
        ]}
      />
    </DetailSection>
  );
}
