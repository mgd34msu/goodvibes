# Knowledge, artifacts, and multimodal

GoodVibes Agent uses the daemon's one knowledge store, the same the terminal app and the web app's Library use. The Agent's earlier store of its own, Agent Knowledge (`~/.goodvibes/agent/knowledge-agent.sqlite`), was carried into it once at the daemon's first start of this version, every source, extraction, entry, link and issue the daemon's store did not already hold; the old file is left as it was, so a rollback still reads it. The record of the carry is `agent-knowledge-carried.json` beside the daemon's store.

## Context layers

GoodVibes Agent uses these context layers:

- current conversation context for the active turn;
- Agent-local memory records for durable but private assistant facts and preferences;
- VIBE.md personality files, project context files, plus Agent-local routines, skills, and personas for reusable behavior profiles;
- the daemon's knowledge for source-backed documents, search, and semantic answers;
- artifacts for uploaded/generated files that can be referenced by chat, delegation, or explicit knowledge ingestion.

These layers are intentionally separate. VIBE.md, project context files, local memory/routines/skills/personas are not automatically promoted into knowledge. Secrets are rejected or represented only by explicit secret references.

## The Agent's knowledge routes

The Agent's knowledge tools and its CLI use the Agent route family, which the daemon serves from its one knowledge store:

```text
GET  /api/goodvibes-agent/knowledge/status
POST /api/goodvibes-agent/knowledge/ask
POST /api/goodvibes-agent/knowledge/search
GET  /api/goodvibes-agent/knowledge/sources
GET  /api/goodvibes-agent/knowledge/nodes
GET  /api/goodvibes-agent/knowledge/issues
GET  /api/goodvibes-agent/knowledge/items/{id}
GET  /api/goodvibes-agent/knowledge/map
GET  /api/goodvibes-agent/knowledge/connectors
GET  /api/goodvibes-agent/knowledge/connectors/{id}
GET  /api/goodvibes-agent/knowledge/connectors/{id}/doctor
POST /api/goodvibes-agent/knowledge/ingest/url
POST /api/goodvibes-agent/knowledge/ingest/urls
POST /api/goodvibes-agent/knowledge/ingest/artifact
POST /api/goodvibes-agent/knowledge/ingest/bookmarks
POST /api/goodvibes-agent/knowledge/ingest/browser-history
POST /api/goodvibes-agent/knowledge/ingest/connector
POST /api/goodvibes-agent/knowledge/reindex
```

If those routes are unavailable, Agent commands fail closed with a structured error. They do not retry against the default knowledge routes or arbitrary knowledge-space selectors.

The CLI rejects route-selection flags such as `--space`, `--knowledge-space`, `--knowledge-space-id`, and `--include-all-spaces`.

Successful route responses are validated before rendering. Parseable public Agent-route scope aliases are normalized.

Knowledge writes are explicit-user-action paths: the CLI forms that ingest, import, review issues or reindex take `--yes`; inside the Agent a form submitted in Memory and knowledge is the request. Ask, search, status, list, get, map and the connector reads only read.

## Ask and search

Inside the Agent, "Ask your knowledge" (`q` anywhere in Memory and knowledge, the menu `Ctrl+G` then `m` or `/memory`) gives source-backed answers. `goodvibes-agent ask <query>` is the scriptable equivalent over the same route. Default output is concise:

- answer text or a clear no-match state;
- confidence when present;
- sources, titles, and URLs when returned;
- facts, gaps, and refinement task ids only when the Agent Knowledge route returns them.

`--json` preserves the raw structured Agent route response for tooling after the scope-contamination guard accepts the payload.

The command layer does not turn search results into an answer locally.

Inside the Agent, "search" on the Sources tab of Memory and knowledge searches interactively; it and `goodvibes-agent search <query>` render bounded results with title, id, type, score, source, URL, and snippets when available. An empty store says so.

Read-only inspection is the Sources, Entries, Issues, Jobs and Connectors tabs of Memory and knowledge (each item in full on `Enter`; the map, what a task would get, a connector's check), with CLI equivalents for scripts (`goodvibes-agent knowledge list`, `get`, `map`, `connectors`).

The main assistant conversation can use the read-only `agent_knowledge` tool for status, ask, search, source/node/issue list, item lookup, map, connector list, connector detail, and connector doctor workflows, and `capability_run` with the `knowledge.*` capabilities.

## Ingest

Memory and knowledge has the forms to add a web page (`a`), a list of pages, bookmarks, a file, a saved artifact, your browser history (yours only) and something through a connector; to review an issue, tidy (a quick or a deep pass), rebuild, and stop a waiting or running job. The main assistant conversation can also call the confirmed `agent_knowledge_ingest` tool for URL, file, artifact-id, URL-list, bookmark, browser-history, and connector source families. `goodvibes-agent knowledge ingest-url <url> --yes` and the other CLI forms are the scriptable equivalents:

- `goodvibes-agent knowledge import-urls <path> --yes`
- `goodvibes-agent knowledge import-bookmarks <path> --yes`
- `goodvibes-agent knowledge import-browser-history --yes`
- `goodvibes-agent knowledge reindex --yes`

The CLI targets `/api/goodvibes-agent/knowledge/*`; the place runs the `knowledge.*` capabilities in the daemon. Both reach the same one store.

Do not map VIBE.md, project context files, local memory, notes, routines, skills or personas into knowledge automatically. Durable source-backed facts can be ingested deliberately when the user or an explicit Agent workflow asks for it.

## Artifacts and multimodal

Artifacts are first-class runtime objects for files, images, audio, video, generated outputs, and delegation results. Agent Knowledge use of artifacts must still go through Agent-specific ingest routes when those are available.

The saved artifact list is the Artifacts tab of Memory and knowledge (the menu), the `artifacts.list` capability, and `agent_artifacts`; it is the daemon's one artifact store, the same in the Agent, the terminal app and the web UI (the Agent's own earlier store was copied into it once, under the same ids, at the daemon's first start of this version). It lists recent uploads, exports, generated media, source artifacts, session artifacts, comparison artifacts, sourced research reports, and exported document drafts with filters for query, kind, MIME type, purpose, and source. `agent_artifacts mode:"show"` inspects one artifact by id with redacted metadata and a bounded preview for text-like content only; binary bytes and inline base64 stay out of the transcript.

Related saved-artifact actions:

- "Copy to a file" (`e` on an artifact) copies one artifact to a file of this project, preserves exact bytes for text or binary artifacts, and refuses to write over a file unless you choose so.
- "Copy into a package" (`k`) copies selected reviewed artifact ids into a workspace package directory or ZIP archive with exact bytes under `artifacts/`, a redacted `manifest.json`, and a README.
- "Attach an artifact" (`k` on a draft, Drafts tab of Memory and knowledge) links one reviewed saved artifact id to a document without rewriting the body.
- "Add a saved artifact" (`j` on the Sources tab of Memory and knowledge) adds one saved artifact id to your knowledge.

"Make an image or a video" (`M` on the Tools tab of Tools and extensions) creates image/video artifacts through the daemon's configured media providers and opens the saved file in the desktop's viewer after your own press, and "collect a media job" in the Work place collects a job that was still being made. The main conversation can perform the same confirmed action with the `agent_media_generate` tool when the user explicitly asks for generated media. Generated media output is summarized as artifact ids, MIME types, filenames, and source URLs when present; inline base64 is not printed into the transcript.

The model can use first-class tools for the common route-selection, Knowledge, document, packet preset, packet share, artifact, autonomy, research, model/provider, computer/browser, device/voice, security, media, and comparison workflows; the full tool catalog with a one-line purpose per tool is in [Tools and commands](tools-and-commands.md). `route action:"plan"` maps a plain user request to the preferred visible Agent route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without executing tools.

`agent_documents` creates, revises, reviews, comments on, suggests changes to, lists, shows, attaches saved artifacts to, inserts saved artifacts into, and exports project-scoped versioned markdown drafts as saved artifacts after explicit confirmation for writes. Exports include a reviewer appendix with comment and AI suggestion summaries plus metadata counts for open/resolved comments and proposed/accepted/rejected suggestions.

Suggested changes stay pending until the user accepts or rejects them; acceptance appends a new draft version. Artifact attachment records a reusable artifact reference and export manifest without changing the document body; text artifact insertion adds bounded markdown content to a new draft version; non-text artifact insertion adds a safe reference block without binary bytes or base64.

`agent_review_packet_presets mode:"save"` writes one confirmed local JSON artifact containing reusable document/export/comparison/judgment/route-decision/handoff/archive/related artifact ids; `mode:"list"` and `mode:"show"` inspect saved presets, flag missing or superseded saved ids, and recommend newer matching reuse routes when metadata is sufficient; `mode:"refresh"` saves one new confirmed preset artifact from those freshness recommendations while preserving the source preset and without mutating documents, model routing, handoffs, or archives; refreshing a preset that was already refreshed returns its successor instead of saving a copy, and `mode:"list"` counts replaced presets instead of listing them. `mode:"save"` refuses an artifact id the store does not hold before writing, and `mode:"delete"` removes one preset without touching the artifacts it names. `agent_review_packet_share` validates one saved reviewer handoff archive and sends it through a configured channel target: attached where the surface carries files, otherwise named in the message with the export route to send it by hand. The result says which happened.

`research action:"briefing|plan|search|runner|runs|run|sources|source|bundle|reports|report_artifact"` exposes a read-only next-action queue, read-only planning, bounded public source-candidate search, browser-runner readiness, run/source inspection, reviewed-source bundles, and saved research report artifact inspection; confirmed `research action:"create_run|start_run|checkpoint|pause|resume|cancel|complete|fail|delete_run|add_source|review_source|reject_source|use_source|delete_source|report"` performs one visible research mutation or sourced report save after explicit user request. A report saved with `runId` and no `sources` cites the run's reviewed sources from the source store (or the ones named in `sourceIds`); after the save those sources are marked used and the run is completed with the report, and the result names each of the three outcomes. `complete` and `use_source` refuse a report artifact id the artifact store does not hold.

`models action:"status|route|local|providers|provider"` exposes read-only model route, local cookbook, provider, and subscription posture; confirmed `models action:"smoke"` performs local server smoke checks through existing confirmation gates. `computer action:"status|plan|control|browser|setup|mcp"` exposes read-only browser/PWA, browser/screenshot/desktop-control planning, repair/setup, and trusted tool discovery posture; confirmed `computer action:"open_browser"` performs the visible browser cockpit handoff through existing confirmation gates.

`device action:"status|capability|voice|provider"` exposes read-only companion/mobile, voice, and provider posture; confirmed `device action:"open_tts_provider|open_tts_voice"` performs visible TTS picker handoffs through existing confirmation gates. `security action:"status|finding|explain"` exposes redacted security posture, exact finding inspection, and read-only policy explanations for why one model action is allowed, denied, or waiting on confirmation.

The lower-level `agent_research_runs`, `agent_research_sources`, `agent_research_report`, `agent_harness mode:"route_decision"`, `agent_harness mode:"research_briefing"`, provider/model, pairing/media posture, security posture, policy explanation, and UI-surface harness modes remain available as detailed compatibility routes over the same local records, artifacts, and route contracts.

`research action:"briefing"` summarizes local run/source/report/browser posture and returns exact follow-up routes without writes. Research run state keeps plan, phase, progress, checkpoints, log tails, source ids, lifecycle controls, and no hidden background execution. `research action:"search"` runs bounded public web research and returns source candidates with exact confirmed `add_source` routes; it never writes the source queue by itself. Research sources keep credibility, score, report-ready source lines, reviewed-source bundle handoff, and review/reject/use state; they never ingest Agent Knowledge or save a report by themselves.

Research reports save one confirmed sourced markdown artifact with a source map, redacted source URLs, source-count metadata, citation coverage metadata, repair hints, optional strict body-citation enforcement, optional `visualReport:true` packet sections, direct `research action:"reports|report_artifact"` inspection, and no inline report content in the transcript.

`agent_artifacts mode:"export"` copies exact saved artifact bytes to a validated workspace path after confirmation and refuses accidental overwrite; `mode:"package"` copies selected saved artifacts into a validated workspace directory with exact bytes, redacted metadata, README, and manifest; `mode:"archive"` writes the same package payload as one ZIP file. `agent_knowledge_ingest` accepts `sourceKind:"artifact"` plus `artifactId` for reviewed saved-artifact promotion.

Blind model comparison can run from a direct prompt or a saved text artifact id, and saves a local JSON artifact with the full prompt, blinded outputs, source artifact metadata, and reveal map while keeping model identities hidden in the transcript until reveal. Saved comparisons are listed on the Comparisons tab of Models and providers (the menu), each named by its prompt, and from there:

- rendered as side-by-side reviewer views with related document/artifact excerpts
- converted into confirmed judgment artifacts
- summarized as task/document/benchmark-filtered saved preference analytics or synthesized into cross-session preference themes
- exported as local markdown reports
- combined with related document or artifact exports into reviewer handoff artifacts
- compared through split-pane reviewer handoff diffs with section jumps and recent-handoff choices from artifact metadata
- archived as one ZIP artifact with the handoff, source comparison or judgment, related evidence bytes, matching route-decision receipt bytes, README, archive metadata, and redacted manifest
- applied to the main model route only through a separate confirmed winner-update action
- saved as apply-winner or leave-unchanged route-decision receipt artifacts

"See the review packet timeline" (`h` on the Drafts tab of Memory and knowledge, `documents.timeline`) shows a chronological review packet timeline across document, comment, suggestion, attachment, export, compare, judgment, route-decision receipt, packet preset, handoff, and archive events, and "See the review packet steps" (`t`, `documents.packet-steps`) shows the review packet steps: what is ready, what is missing and what fixes it. The daemon computes both from the project's drafts and the saved artifacts, for every program.

The drafts and artifacts are the Drafts and Artifacts tabs of Memory and knowledge; comparisons are the Comparisons tab of Models and providers; "Check a draft is ready for review" (`d` on the Drafts tab, `documents.readiness`) lists what still stands in the way of review (open comments, suggestions waiting, missing sources, hidden comparisons, the handoff) before an export, a handoff or archive, or applying a winner, and every change still asks or names its blanks.

`autonomy` adds ongoing-work route selection plus visible queue and item inspection. Lower-level `agent_harness` adds:

- compatibility autonomy modes
- live research run, connected-host task, approval, automation run, and schedule records/log tails
- lower-level research/device/media mode inspection
- `document_ops`/`document_ops_lane` readiness, including review packet timeline with stale preset attention, guided packet wizard progress, refreshed-preset lineage, route-decision receipts, and packet presets/defaults/share handoff and freshness posture
- visible reviewer-readiness preflight for unresolved comments/suggestions/source evidence/comparison reveal/route decisions/handoff evidence
- `sessions`/`session` bookmark and artifact posture
- confirmed slash-command mirrors when a visible workspace route maps to a concrete command

Multimodal outputs should stay in the conversation, artifacts, local notes or memory, or explicit delegation results unless the user explicitly ingests a reviewed source through an Agent Knowledge route. They must not be inserted into default knowledge.

## Related docs

- [Tools and commands](tools-and-commands.md)
- [Getting started](getting-started.md)
