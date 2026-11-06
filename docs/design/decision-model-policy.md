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

Ordinary Classic agent spawns use the platform's existing standalone worker
execution and owned cancellation/settlement machinery. Their tools, capability
ceilings, workspace and execution intent remain bound; records identify Classic
and do not claim contract acceptance. A native Classic conversation can delegate
through this path. Autonomous contract starts and fresh resumes explicitly require
decision models before creating new work; existing durable receipts remain readable.
Automated checkout also reports that requirement before driver acquisition,
reservations, approval windows, card filling or payment submission. Budget and
payment-ledger inspection remain independent of that unavailable automation.

Classic resume summaries use structured approval counts when the host supplies
them. Otherwise the count is unknown and the live approval queue is named;
historical prose is not treated as current authorization state. Channel controls
use explicit `/status ID`, `/cancel ID` and `/retry ID` commands for current host
targets. Classic owner replies to ordinary approval requests use `/approve ID`
or `/deny ID`, subject to the existing authenticated broker and owner-proof
requirements. Natural-language work-proposal and payment-window interpretation
requires decision models and cannot silently resolve those records in Classic.
Remote ingress retains local PAN/checksum and protected-literal checks. Classic
also handles explicitly labelled security-code and expiry shapes locally; bare
short numbers are not semantically classified. Findings retain only positions,
kinds and Classic provenance, never the matched secret text.

Classic catalog search uses literal token overlap and stable source ordering.
These scores describe local retrieval, not confidence or Jev readings. Selecting
an operation requires an explicit catalog identity; a fuzzy match remains a
suggestion. The source owner's privacy checks, cancellation and original-data
currentness guards still precede publication or subsequent execution.

Private-source screening keeps its explicit source-specific route and retention
grant. It never forwards raw source to the global failover chain merely because
that private route failed. Preferred may fall back to local literal screening
after a verified private decision-service outage; malformed responses, privacy
failures, revoked authority and actual semantic refusals remain held. Classic
screening receipts attest only the local checks. Query-bearing research links
remain omitted when their parameter roles cannot be assessed.

Provider adapters retain their documented wire tables in Classic. An unknown
stop reason remains unknown; arbitrary error prose cannot trigger another API
attempt. Declared catalog/runtime metadata still governs setup and reasoning
options. Unclassified model families use the existing adapter defaults rather
than a decision lookup. Undocumented content types that require interpretation
report that limitation. Raw process output remains visible without inferred
error classifications or inferred server ports.

Settings ingestion names unknown keys without guessing a replacement. Unknown
config-event values stay masked, and managed settings bundles report their risk
as unassessed when changed values were not semantically reviewed. Sandbox
host-access checks and optional advisories require owner approval during Classic;
advisory auto-approval cannot manufacture an approval or a decision receipt.

Classic conversation setup does not classify the user's intent or inject an
automatic semantic plan. An explicit planning command retains the original owner
input without claiming it was judged a goal. Local Markdown plans use exact
status labels and checkbox values; noncanonical labels produce a parse notice.
The adaptive planner defaults to one worker, with no semantic ranking, while
retaining explicit owner strategy choices. Archetypes remain listable with
unclassified families; prose-based orchestration selection reports its decision
model requirement before creating a task.

Classic registry discovery uses local query terms without selecting or executing
a discovered tool. Project inspection retains manifest, lockfile and declared
test-runner facts; inferred entry points remain explicitly unassessed. Env audit
can compare a single conventionally named example/sample/template file. Test
discovery can name an importing file with an explicit test filename convention,
and marks that source rather than claiming semantic verification. Security
inspection reports redacted local credential-pattern candidates, actual env file
presence and filesystem mode bits. It does not claim complete semantic coverage.

Semantic diff and compatibility modes expose the actual diff with an unassessed
risk/compatibility result during Classic. Semantic dangerous-call assessment,
frontend issue assessment and inferred API-registration verification report their
decision-model requirement; they cannot return an apparently clean scan or write
an inferred API artifact. Summary formatting preserves these limitations and
Classic provenance.

Child failure envelopes retain their actual error, termination metadata and
partial output in Classic. Free-text failures keep the generic error code;
stamped host reason codes remain authoritative. Editor notices use a neutral
presentation without a semantic blocking claim, and declared secret echoes stay
protected. Service-log display and transcript export keep local redaction and
original source/currentness checks without acquiring an unused decision owner.
Cluster joins accept an unambiguous exact declared group name or ID in Classic;
description-based selection does not authorize a join.

Post-response memory bookkeeping records only the host's actual prompt presence
in Classic. It cannot credit a memory as referenced without assessing that use.
Idle semantic consolidation produces an explicit skipped receipt and makes no
merge, decay or archive writes. Automatic semantic knowledge-consolidation
features report their decision-model requirement before starting a Classic pass;
existing memory retrieval and explicit owner review remain available.

Classic browser actions retain the existing exact snapshot URL, structure,
control-name, uniqueness and action-owner checks. A paraphrased control requires
a fresh snapshot instead of semantic identity approval. Unassessed page purpose
never grants credential entry. Browser launch/provisioning failures keep generic
diagnostics and exact host errno facts; prose cannot authorize library installs
or cause-specific repairs. Voice failures retain actual process signal facts
without inferring a microphone/model cause or disabling an engine from prose.
Calendar failures name a missing permission only from the supported exact
authentication challenge; otherwise the original provider refusal remains.

When a turn has read untrusted content, Classic cannot attest that outgoing
content is unrelated to it. The shared outward-effect boundary uses its existing
exact action-and-payload owner approval path, with the existing expiry and source
rules. It does not invent a clean derivation result. Connected-host operator
checks follow that same policy without eagerly acquiring an unused model port.
If a hosted conversation fails after completing work, Classic reports the failed
input for inspection/resume and does not automatically replay the whole turn.

Conversation prompt composition uses fixed generic tool reminders in Classic;
it does not ask a model to classify the answering model's capability tier. Model
catalog refresh preserves published prices/limits while leaving interpreted
provider billing access unknown. Copilot's declared endpoint/vendor facts remain
authoritative; its Classic compatibility rule uses the explicit Claude ID prefix
only when those facts are absent. Failed optional prompt caching falls back to
an uncached answer without interpreting failure prose. Command suggestions use
local declared titles, aliases and keywords, without executing a suggestion.

## Completion evidence required

All four products, daemon-hosted and headless sessions, and background work must
consume the same platform policy. Qualification must cover all three policies,
missing credentials, unavailable local services, exhausted failover, mid-task
outages, approvals, refusals, cancellation, restart and duplicate execution.
Classic end-to-end tests must observe zero decision-model requests, including
completion and error handling. Call-site inventory and capability dispositions,
settings, generated contracts and release notes must be current before delivery.
Code is committed and pushed to main before CI repair; release uses a fresh tag.

Classic knowledge listing uses the requested native namespace and retains the
original source, extraction, topology, cancellation and caller-currentness
checks. Local search ranks literal token overlap, labels that score source and
omits semantic probabilities. Explicit knowledge packets quote complete local
fields with exact offsets and identify Classic provenance; they do not claim
semantic excerpt verification. A Preferred outage cannot revive a record already
excluded by scope reading or silently clear a settled relevance/excerpt negative.

Semantic knowledge enrichment, independently verified answers, self-improvement
and semantic reindexing report their limitation before starting those operations.
Manual semantic job starts are refused before queuing or creating a run record.
Existing semantic schedules keep their saved cadence while Classic pauses their
execution; local lint and projection rendering remain available. Automatic
semantic enrichment is omitted during Classic. Knowledge ingestion and Home
Graph callers remain under implementation review; this document does not certify
end-to-end qualification.

Classic schedule input accepts a complete zoned ISO timestamp, five-field cron,
`every 30m` or `in 2h`, with ordinary calendar/quantity validation and the supplied
source clock/timezone. It never extracts executable timing from quoted examples,
negation or a larger paragraph. Unsupported prose names the decision-model
limitation; accepted Classic schedules have no model confidence. Structured
schedule APIs remain available independently.

Hook-contract and operational-playbook searches use labelled literal catalog
matching in Classic. Searching executes no hook, check or remediation. Email
keeps IMAP response-code and server-declared folder facts, while unstructured
refusal and cursor diagnostics remain explicitly unassessed. A Drafts folder
without a server declaration requires an explicit mailbox choice before APPEND;
Classic never guesses a destination from a folder name. Account/publication
ownership and cancellation remain attached to these local results.

Classic channel progress keeps original notices visible without assigning a
semantic substance verdict or consuming an old model-specific suppression cache.
Worker prompts retain declared test-runner facts and omit inferred framework and
repeated-call progress hints. The read-only secret check escalates to the existing
secret-aware approval path when unassessed; it never reuses a cached semantic
absence of secrets during Classic or asserts that unknown file contents are safe.

Classic explicit knowledge ingestion retains artifact bytes, parser-derived text,
structural sections and declared project/provider metadata without semantic
readability, alias or main-content certification. Extraction and source metadata
identify Classic and `semanticAssessment: not-evaluated`. Additional inferred
aliases are omitted; source-declared identities retain native evidence guards
and untrusted provenance. URI `ref` occurrences whose meaning is unresolved stay
in the address, preventing a local guess from merging different source identities.
HTML retains literal rendered blocks. PDF parsing retains explicit decoding facts
and omits ambiguous raw-stream encodings rather than inventing an interpretation.

Ordinary Classic reindex and source refresh may rebuild the local catalog from
retained artifacts. Their semantic enrichment is omitted and reported as
`not-evaluated`; the dedicated semantic enrichment/reindex APIs remain decision
features. These paths retain atomic source/extraction/graph publication and do
not replay an artifact fetch when a side-effect-free reading falls back.
