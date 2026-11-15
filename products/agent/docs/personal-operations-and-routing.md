# Personal operations and task routing

`personal_ops` forwards to `agent_harness`, which picks one of ten personal
operations (including the two calendar and the two task variants) by ranking
the operation catalog with the shared `engine.tools.registry-rank` judgment.
Candidate order and confidence come from those readings. Agent adds no keyword
intent, preference weights or default task fallback. A ranking never grants
effect permission and never replaces connector discovery or redaction.

## Choosing a record or lane

- A free-text queue or lane query is ranked. An exact lane id stays
  deterministic, and an empty queue query keeps the readiness ordering.
- A request that names a record without an exact identity returns suggestions
  only: `selection_required` with `exact_record_identity_required`. Retry with
  the exact record id. A missing explicit record id never falls back to another
  record, and even a confident low-stakes reading cannot authorize a provider read.
- An uncertain reading returns `deferred` with a machine-readable reason. No
  clarification or approval loop is added.
- Exact execution keeps the existing effect, readiness, required-field and
  confirmation checks. MCP stays the permission owner, and the source session is
  rechecked immediately before dispatch. Cancelling the tool call reaches the
  MCP call.

## Privacy

The query, identity and catalog description are screened locally before they
are displayed or ranked; the display projection is capped at 600 characters.
Credential-like or other protected material is refused before any local or
hosted request. When local screening is missing or unsettled the operation is
held; there is no hosted screening fallback. Private metadata is not sent to
ranking. Candidate ids are opaque so source identity cannot reach the decision
log. If the authority, judgment binding or session changes mid-request, the
operation is refused rather than dispatched late.

Status and briefing work as usual when no screening owner is installed.

## Task-route planning

Route tools plan only; they never dispatch a returned route. A plan is one of:

- ready: matches carry an actionable yes from the ranking, with the original
  decision ids in `judgment`;
- uncertain: an unresolved required reading yields an `uncertain` plan with no
  preferred route, ordinary matches or executable recommendation.

A catalog that is not supplied is optional; a supplied catalog that fails
returns the failure, not an empty result. If a named channel's live listing
changes while a plan is pending, the plan is rejected. Cancellation is honoured
before readings and before publication.
