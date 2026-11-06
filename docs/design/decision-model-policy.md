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
An outage also cannot reopen an action already refused in the current operation
or publish a final answer with a still-confirmed semantic failure. A fresh
successful decision may resolve that hold; explicit Classic selection starts a
new operation without representing it as decision-model approval.

Classic uses owner approval where `safe-jev` would have decided. Explicit YOLO
remains an independent permission choice. Authentication, workspace scope,
secret handling, cancellation, spending limits and duplicate-execution protection
remain host rules. Results must identify Classic provenance and must not claim
that independent semantic verification occurred.

The Decision Router uses its configured General answer target during Classic
operation, with no categorization call. Decision-only capabilities must expose
their limitation before execution; they must not be backed by fake answers.

Native conversation intake retains a separate owner-provenance record for Classic
admission. Its paired identity, original input, current source and durable dispatch
claim still apply. It neither forges an autonomous act decision nor starts a native
work contract. An authenticated retained turn permit carries Preferred fallback
into the actual conversation; caller-supplied policy fields cannot grant it.

The daemon reports current operation policy through `x-goodvibes-decision-policy`.
Browser observations reset with the selected account/host lifetime. Classic browser
features use lexical command matching, declared code languages or plaintext,
punctuation-based speech chunks, and explicit reply prefixes. Unknown credential
fields remain masked; ambiguous credential-provider associations require manual
selection. These presentation results carry Classic provenance without model
probabilities or decision receipts. A semantic browser request made by another
client while Classic is active reports `JUDGMENT_CLASSIC` without model I/O.

Classic tool handling retains exact and whitespace-normalized edits, bounded
regex workers and explicit interactive commands. It requests an exact target
instead of guessing a fuzzy edit. Search results use stable local ordering;
overflow shows a head/tail excerpt with the full retained-output reference.
An unsuccessful command is not automatically replayed on a guessed retry class.
Unstructured notices use a neutral display default and transcript category;
declared runtime events keep their actual structured levels. Classic compaction
quotes history mechanically, marks clipping and leaves semantic quality scores
absent. Automatic semantic repair is explicitly unavailable; validation errors
and the original candidate remain available for a corrected explicit edit.

Classic fetch exposes literal extracted page text and a clearly labelled excerpt
and heading outline. URL syntax, HTTPS, credential-free addresses, permitted
ports, exact registrable-domain comparison and per-hop redirect checks remain
deterministic. An accepted Classic URL does not claim semantic host verification.
Only declared public HTTP headers bypass credential handling; unknown custom
headers remain protected. Explicit memory/code searches retain literal or vector
retrieval, with score sources named; optional semantic prompt enrichment is omitted.

## Completion evidence required

All four products, daemon-hosted and headless sessions, and background work must
consume the same platform policy. Qualification must cover all three policies,
missing credentials, unavailable local services, exhausted failover, mid-task
outages, approvals, refusals, cancellation, restart and duplicate execution.
Classic end-to-end tests must observe zero decision-model requests, including
completion and error handling. Call-site inventory and capability dispositions,
settings, generated contracts and release notes must be current before delivery.
Code is committed and pushed to main before CI repair; release uses a fresh tag.
