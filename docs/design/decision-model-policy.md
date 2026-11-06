# Decision-model policy

Status: implementation in progress. End-to-end qualification and release remain pending.

The platform owns `judgment.policy`, independently of `permissions.mode`.
Existing installations retain **Default - On** when the setting is absent.

| Policy | Contract |
| --- | --- |
| Default - On | Try the configured finite decision-model chain; stop on exhaustion. |
| Preferred | Try that chain; availability exhaustion selects Classic for the current operation. |
| Classic - Off | Use Classic from startup and send no decision-model requests. |

Classic supports conversation, owner-approved tools, editing, command execution,
ordinary test results, final responses and session recovery. It does not invent
semantic answers, acting-confidence scores, decision call IDs or Jev receipts.
General-purpose conversation models remain available: disabling decision models
does not disable the model answering the user.

Policy is pinned to an owned operation. A policy configuration change revokes
the operation. Preferred fallback preserves transcript and execution records;
only a side-effect-free decision phase may re-enter through its Classic path.
Already executed tools are never replayed. A real semantic refusal, cancellation,
privacy rejection, malformed answer or revoked authority cannot trigger fallback.

Classic uses owner approval where `safe-jev` would have decided. Explicit YOLO
remains an independent permission choice. Authentication, workspace scope,
secret handling, cancellation, spending limits and duplicate-execution protection
remain host rules. Results must identify Classic provenance and must not claim
that independent semantic verification occurred.

The Decision Router uses its configured General answer target during Classic
operation, with no categorization call. Decision-only capabilities must expose
their limitation before execution; they must not be backed by fake answers.

## Completion evidence required

All four products, daemon-hosted and headless sessions, and background work must
consume the same platform policy. Qualification must cover all three policies,
missing credentials, unavailable local services, exhausted failover, mid-task
outages, approvals, refusals, cancellation, restart and duplicate execution.
Classic end-to-end tests must observe zero decision-model requests, including
completion and error handling. Call-site inventory and capability dispositions,
settings, generated contracts and release notes must be current before delivery.
Code is committed and pushed to main before CI repair; release uses a fresh tag.
