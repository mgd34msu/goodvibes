# First WebUI battery readers

These are server-only definitions and readers for the browser judgment registrations. The surrounding `webui-runtime.ts` source owner and daemon `browser-judgment-composition.ts` install the error, speech-seam and provider-catalog readers under authenticated host ownership; this reader layer itself grants no access or transmission permission.

`webui-adapters.ts` implements the published `BrowserJudgmentBattery` descriptor contract. `webuiDaemonRefusalAdapter` resolves existing server references with the fresh `currentPrincipal` callback. No browser text-staging endpoint or private-source permission is created here.

The web UI command palette, code-block language, settings key classification and credential-to-provider highlight are decided in the browser by code (the palette's lexical matcher, the bundled highlighter's own detection, the engine's declared config key facts, the provider catalog and the provider's own sign-in routes); none of them asks a model. `webui-status-catalog.ts` contains exhaustive structural tone mappings for the current companion-session, knowledge-job, knowledge-refinement and provider-account auth enum types. `readWebuiStatusCatalog()` is caller-side; unknown labels stay unsupported. Status tone is always read from this table; no model is asked for it. The public `judgment-browser/catalogs` entrypoint re-exports only these pure catalogs, the declared-fact rules below and erased types. Its browser graph includes no provider, source resolver, log or SQLite implementation.

The adapters return the actual framework readings on both settled and held projections. An item outcome is never weakened to make a compound usable, and held projections contain no business `value`. Published PR41 `2142bab8` supplies the optional `structuralBasis: { method_unknown: 'http-status-not-404' }` for four genuine refusal readings, and held-only `compoundOutcome: 'escalate'` for conflicting facts. A missing valid HTTP status holds before the port. The service consumes `compoundOutcome` as a minimum for the wire `outcome`; it does not emit a second outcome field. The adapters do not synthesize a fifth reading or alter individual outcomes. Both cases are covered through the actual service and decision log in the focused adapter tests.

The source-level adapter API also exports `WebuiDaemonRefusalRun`. The run type contains server-only framework evidence; it is not an HTTP result type.

`webui-specs.ts` exports the WebUI batteries and `WEBUI_BATTERY_QUESTIONS`. Questions, item names, criteria and decision sites are fixed. Fixtures are synthetic calibration inputs; offline replay verifies the harness, not real-model calibration or accuracy.

`webui-readers.ts` exports `readStructuredDaemonRefusal(input)`, the caller-side path before the interpretation endpoint: it returns a structural result without probabilities or decision IDs, or `undefined` when semantic reading remains necessary. It also exports the `snapshotWebui*` functions that screen and capture each complete source before any port or log use. The reading itself runs through the adapters in `webui-adapters.ts`, which the service drives; an unsettled result preserves `confirm` versus `escalate`, including in a compound ranking, and typed per-item evidence is attached by the foundation to the admitted decision log.

## Facts the program declares are never read

Code answers these at once, in the browser and in the adapters, from the same declarations exported by `catalogs.ts`. An adapter refuses (`JUDGMENT_INPUT_HELD`) a request about a declared fact before any model call, so a reading is spent only on what no declaration covers:

- Reply subject: `replySubjectLine(subject)` (`reply-subject-marker.ts`) reads the leading `Prefix:` chain against the known localized reply and forward markers and prepends `Re: ` when no reply marker leads. The web UI's Reply and the daemon's drafted replies both use it; no model is asked.
- Code grammar: `readFenceTagLanguage(tag)` (`code-fence-language.ts`) maps a fence tag or its highlighter alias to a grammar.
- Provider credential names: a built-in provider (`isDeclaredCredentialProvider`) declares every name it reads (`readDeclaredProviderCredential`).
- Status tone: `readWebuiStatusCatalog()`; there is no status battery.

## Resolved server projections

The exact types are in `webui-types.ts`. They are **not browser request schemas**.

- Refusal: `{ methodId, message, status?, code?, category?: 'network' | 'authentication' }`. The selected original failure message must retain complete context. Omit stack, body payloads, headers, URLs and unrelated data

## Before provider and logging

The service must establish source access, source/purpose permission, route clearance **and retention policy before any call, state hash or log**. Private text remains private even if the reader's shape scanner finds no credential/card syntax. There is no `public`, `safe`, consent or route flag here. The reader's complete-input snapshot is an additional guard, not admission authority. The service must also preflight the complete source before its own resolver narrows it.

`webui-answers.ts` exports `validateWebuiAnswers(questions, raw)` and `withWebuiAnswerBoundary(nonRecordingPort, options?)`. The daemon's `composeJudgment` places the boundary per call around its non-recording transport and inside the decision log, and hands the result to the browser route as `JudgmentServices.browserPort` (sharing the transport, lifetime and log of the ordinary port). Its `returnedModels` and `fallbackModels` come from the live `judgment.model`, `judgment.backend` and `judgment.fallbacks` settings, never from browser input. The helper rejects a port with a recorder because an outer wrapper would be too late to stop raw answer/failure retention. Strict outputs reject unknown fields/options/items, nonfinite or out-of-range probabilities, and non-maximal choices. Choice distributions use the foundation's shared approximate-unit admission policy: their total may differ from one by at most 0.01 plus floating-point roundoff. Admitted values are preserved without renormalization. The provider's confidence is preserved separately from the selected option's probability, as the [TypeSafe confidence contract](https://docs.typesafe.ai/confidence) requires. Failure messages, causes and provider request IDs are removed before logging. Valid numeric lineage and its local logical request UUID are retained. Requested and actual model provenance remain distinct: an endpoint's declared response-model aliases map to the model that was requested; absent a declaration only exact identity is accepted.

The foundation recording wrapper stores an unsalted state hash. This helper does not make a private, low-entropy query hash anonymous and does not replace a retention policy. Hold private input when the configured log cannot meet its policy. Neither the readers nor the answer boundary can undo an already-retained hash or response.

## Budgets and cancellation

Errors use at most one logical call and select all unresolved eligible items together; `method_unknown` requires HTTP 404 even with `METHOD_NOT_FOUND`.

Abort prevents new calls and late results cannot produce a ready result. Active cancellation depends on the injected port honoring the signal. The service owns admission/fan-out bounds, provider cancellation and request echo validation. It checks the source (`assertCurrent()`), the route and the host policy once at admission and once at commit; between them source revocation, route revocation and request cancellation abort the run through their signals, and each transmission and retention step checks only that signal and the caller's identity. The shared port owns transient-availability retry/backoff with no total outage cutoff.

Known status consumers use catalog IDs; unsupported text is visibly unclassified and makes no provider request. Error interpretation now awaits real server-issued references at the asynchronous HTTP caller boundary. The default daemon owner binds the closed source purposes to its configured Jev route and existing decision-log metadata policy. Actual daemon tests use synthetic loopback inference; they do not establish live-provider calibration.
