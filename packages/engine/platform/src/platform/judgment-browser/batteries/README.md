# First WebUI battery readers

These are server-only definitions and readers for the browser judgment registrations. The surrounding `webui-runtime.ts` source owner and daemon `browser-judgment-composition.ts` now install the command/error/mail readers under authenticated host ownership; this reader layer itself grants no access or transmission permission.

`webui-adapters.ts` implements the published `BrowserJudgmentBattery` descriptor contract from PR31. `webuiDaemonRefusalAdapter` and `webuiMailReplySubjectAdapter` resolve existing server references with the fresh `currentPrincipal` callback. `createWebuiCommandRankAdapter(sources)` accepts the `WebuiPaletteSources` authority supplied by daemon composition. It must resolve the query and all requested candidates in request order, retain the identity map locally, and bind query provenance together with candidate access/revisions in `sourceBinding`. Its `assertCurrent()` must recheck current identity, `read:sessions`, lifetime and source revisions after async work. The adapter checks the full returned projection before bounds/port/logging and verifies its query, version and candidate count against the request. No browser text-staging endpoint or private-source permission is created here.

`webui-command-catalog.ts` contains the 27 public builtin descriptors from the pinned WebUI source, without callbacks. `webui-status-catalog.ts` contains exhaustive structural tone mappings for the current companion-session, knowledge-job, knowledge-refinement and provider-account auth enum types. `readWebuiStatusCatalog()` is caller-side; unknown labels stay unsupported. Status tone is always read from this table; no model is asked for it. The public `judgment-browser/catalogs` entrypoint re-exports only these pure catalogs, the declared-fact rules below and erased types. Its browser graph includes no provider, source resolver, log or SQLite implementation.

The adapters return the actual framework readings on both settled and held projections. An item outcome is never weakened to make a compound usable, and held projections contain no business `value`. Published PR41 `2142bab8` supplies the optional `structuralBasis: { method_unknown: 'http-status-not-404' }` for four genuine refusal readings, and held-only `compoundOutcome: 'escalate'` for conflicting facts. A missing valid HTTP status holds before the port. The service consumes `compoundOutcome` as a minimum for the wire `outcome`; it does not emit a second outcome field. The adapters do not synthesize a fifth reading or alter individual outcomes. Both cases are covered through the actual service and decision log in the focused adapter tests.

The source-level adapter API also exports `WebuiDaemonRefusalRun`, `WebuiCommandRankRun` and `WebuiPaletteSources`. The run types contain server-only framework evidence; they are not HTTP result types.

`webui-specs.ts` exports the WebUI batteries and `WEBUI_BATTERY_QUESTIONS`. Questions, item names, criteria and decision sites are fixed. Fixtures are synthetic calibration inputs; offline replay verifies the harness, not real-model calibration or accuracy.

`webui-readers.ts` exports `readStructuredDaemonRefusal(input)`, the caller-side path before the interpretation endpoint: it returns a structural result without probabilities or decision IDs, or `undefined` when semantic reading remains necessary. It also exports the `snapshotWebui*` functions that screen and capture each complete source before any port or log use. The reading itself runs through the adapters in `webui-adapters.ts`, which the service drives; an unsettled result preserves `confirm` versus `escalate`, including in a compound ranking, and typed per-item evidence is attached by the foundation to the admitted decision log.

## Facts the program declares are never read

Code answers these at once, in the browser and in the adapters, from the same declarations exported by `catalogs.ts`. An adapter refuses (`JUDGMENT_INPUT_HELD`) a request about a declared fact before any model call, so a reading is spent only on what no declaration covers:

- Reply marker: `readReplySubjectMarker(subject)` (`reply-subject-marker.ts`) reads the leading `Prefix:` chain against the known localized reply and forward markers. Only a short unknown prefix (`unrecognised-prefix`) is sent to `webui.mail.reply-subject`, as advice.
- Code grammar: `readFenceTagLanguage(tag)` (`code-fence-language.ts`) maps a fence tag or its highlighter alias to a grammar. Only an untagged or unknown-tag block is sent to `webui.code.language`.
- Provider credential names: a built-in provider (`isDeclaredCredentialProvider`) declares every name it reads (`readDeclaredProviderCredential`). Only an undeclared custom provider is sent to `webui.credentials.provider-key`.
- Settings keys: a schema key, a declared credential key and a declared card field are answered by the config key facts. Only an undeclared key reaches `webui.config.credential-key` or `webui.settings.card-material-key`.
- Status tone: `readWebuiStatusCatalog()`; there is no status battery.

## Resolved server projections

The exact types are in `webui-types.ts`. They are **not browser request schemas**.

- Refusal: `{ methodId, message, status?, code?, category?: 'network' | 'authentication' }`. The selected original failure message must retain complete context. Omit stack, body payloads, headers, URLs and unrelated data
- Palette: `{ query, registryVersion, candidates: [{ title, group?, keywords? }] }`. The resolver authenticates and snapshots every identity/revision first, retaining its identity-to-index map outside the log. The reader cannot validate identity uniqueness because it deliberately never receives session IDs. Identical descriptor text may legitimately represent different commands

The browser-facing resolver must reject unregistered, duplicate, stale, cross-principal or unavailable candidate references before constructing a projection. Resolve all candidates before the first model call. Empty query is handled by the browser's ordinary grouped command list; it must not be represented as a semantic ranking with invented probabilities.

## Before provider and logging

The service must establish source access, source/purpose permission, route clearance **and retention policy before any call, state hash or log**. Private text remains private even if the reader's shape scanner finds no credential/card syntax. There is no `public`, `safe`, consent or route flag here. The reader's complete-input snapshot is an additional guard, not admission authority. The service must also preflight the complete source before its own resolver narrows it.

`webui-answers.ts` exports `validateWebuiAnswers(questions, raw)` and `withWebuiAnswerBoundary(nonRecordingPort, options?)`. The daemon's `composeJudgment` places the boundary per call around its non-recording transport and inside the decision log, and hands the result to the browser route as `JudgmentServices.browserPort` (sharing the transport, lifetime and log of the ordinary port). Its `returnedModels` and `fallbackModels` come from the live `judgment.model`, `judgment.backend` and `judgment.fallbacks` settings, never from browser input. The helper rejects a port with a recorder because an outer wrapper would be too late to stop raw answer/failure retention. Strict outputs reject unknown fields/options/items, nonfinite or out-of-range probabilities, and non-maximal choices. Choice distributions use the foundation's shared approximate-unit admission policy: their total may differ from one by at most 0.01 plus floating-point roundoff. Admitted values are preserved without renormalization. The provider's confidence is preserved separately from the selected option's probability, as the [TypeSafe confidence contract](https://docs.typesafe.ai/confidence) requires. Failure messages, causes and provider request IDs are removed before logging. Valid numeric lineage and its local logical request UUID are retained. Requested and actual model provenance remain distinct: an endpoint's declared response-model aliases map to the model that was requested; absent a declaration only exact identity is accepted.

The foundation recording wrapper stores an unsalted state hash. This helper does not make a private, low-entropy query hash anonymous and does not replace a retention policy. Hold private input when the configured log cannot meet its policy. Neither the readers nor the answer boundary can undo an already-retained hash or response.

## Budgets and cancellation

Errors use at most one logical call and select all unresolved eligible items together; `method_unknown` requires HTTP 404 even with `METHOD_NOT_FOUND`. Palette reads all candidates (maximum 64) with at most four active calls. Its result represents each candidate once and uses the actual acted-yes probability, sorted descending with input order for ties. One unsettled candidate holds the whole result.

Abort prevents new palette calls and late results cannot produce a ready result. Active cancellation depends on the injected port honoring the signal. The service owns admission/fan-out bounds, provider cancellation, source `assertCurrent()` checks and request/registry/revision echo validation. The shared port owns transient-availability retry/backoff with no total outage cutoff. Source expiry/revocation and caller/runtime cancellation remain authoritative lifetimes, and every transmission and retention boundary rechecks current authority.

The WebUI palette calls the generated authenticated route through `routedFetch` with an abort signal. Its reader binds the response request ID, versions and registry version, requires every candidate's genuine reading and evidence, and maps acted indices to registered local callbacks. Query changes, registry mutations, session snapshot revisions and close/unmount invalidate pending results; execution rechecks registration. An uncertain/held/unavailable response contains no ranked action rows. Clearing the query explicitly restores the unranked command browser. Known status consumers use catalog IDs; unsupported text is visibly unclassified and makes no provider request. Error interpretation now awaits real server-issued references at the asynchronous HTTP caller boundary. The default daemon owner binds the closed source purposes to its configured Jev route and existing decision-log metadata policy. Actual daemon tests use synthetic loopback inference; they do not establish live-provider calibration.

## Mail reply subjects

`webui.mail.reply-subject` adds one fixed yes/no item. The browser supplies only `subjectRef`; settled output is `{ alreadyReply: boolean }`, never generated subject text. `email.inbox.read` may issue `replySubjectRef` only from a canonical complete read whose account epoch, actual mailbox, positive UIDVALIDITY and returned UID are known. Private exact-result maps carry that provenance without accepting browser or sender claims. Ordinary legacy, incomplete or unavailable reads still render but issue no source.

The lease identifies an immutable observed read, not ongoing remote message existence. It authorizes only subject interpretation through the configured Jev route and existing decision-log metadata policy (including the subject-state hash); it never authorizes sending or another mailbox read. Complete original subject screening precedes retention and model work; clipped, ambiguous, protected or unsupported subjects hold. Raw subject, sender, body, account and mailbox values never enter decision-log fields. Only the complete subject is model state.

Config mutations and credential changes synchronously retire account epochs, including ABA changes. Newer source reads, observed mailbox replacement, expiry and shutdown revoke old leases; shared retries recheck fresh authentication, source, purpose and route at every transmission and retention boundary. The WebUI decides the subject by the reply-marker rule at once; only an unknown short prefix waits for a reading, for at most 1.5 seconds. Typing a subject, closing, selecting another message, starting a newer reply, changing client identity or navigating away cancels a pending reading. An unavailable, unsure or late reading leaves the rule's answer (prefix `Re:`), so the draft is never held.

The canonical in-memory IMAP fixtures, authenticated request/response tests and recorded-wire browser replay are synthetic implementation proof. They are not live mailbox/provider verification or hosted browser calibration.

Server-owned `fallbackModels` admits configured cross-model attempt identities.
Returned aliases are validated against the model of the final answered attempt;
neither browser input nor an alias entry can authorize another fallback target.
