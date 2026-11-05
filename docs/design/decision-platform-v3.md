# Decision platform and v3 consolidation

Status: implementation in progress. This document records the agreed scope;
unchecked items describe planned behavior, not shipped capabilities.

All first-party packages share the root version. Development uses
`3.0.0-dev.0`; the qualified release will be `3.0.0`. Protocol and storage schema
versions remain independent. Dependencies resolve from the root lockfile.
Historical changelogs identify retired packages as `legacy-package:name`.

- [x] Restrict trigger conditions to own data properties and primitive operands.
- [ ] Align all manifests, compiled versions, package references and release tooling.
- [ ] Support Jev, Clef, Clef-flash, DiffusionGemma Jev, Kev-9B and Laya through
  model-neutral adapters with explicit endpoint, authentication and capabilities.
- [ ] Try configured decision targets with finite attempt deadlines. Preserve
  complete evidence, cancellation and current authority at each transmission.
  Accept the first valid decision, including a refusal. On exhaustion, halt the
  operation and explain how to check credentials, endpoints and local services.
- [ ] Add an opt-in Decision Router provider. Other providers make no additional
  routing decisions. Each category selects a provider, model and supported effort.
  Empty categories forward to the required General target. Custom categories
  and descriptions are editable; recursive routes are forbidden.
- [ ] Include lookup/navigation, coding/implementation, analysis/decisions,
  documentation/writing, summarization/extraction, general, debugging/diagnosis,
  review/verification, research and data analysis.
- [ ] Keep routing context small and distinct from answering context and the
  complete saved transcript. Expand within explicit limits for ambiguous turns;
  preserve active task continuity across brief lookup turns. Pin the selected
  answer model through each user turn, including streaming and tool execution.
- [ ] Show the actual route and attribute actual model usage and cost in products.
- [ ] Consolidate duplicated terminal behavior into the engine platform and
  existing terminal-shell, preserving product-specific adapters and views.
- [ ] Share equivalent rejected-promise draining without hiding meaningful errors.
- [ ] Add deterministic judgment-call budgets for representative operations,
  distinguishing logical decisions from wire attempts. Live calibration is optional.
- [ ] Clarify current versus target behavior in docs; retain justified negative
  type tests and guarded optional-import shims. Refresh test navigation.
- [ ] Complete focused and integrated checks, generated contract/API checks,
  packaging and installed-artifact qualification, and CI on the merged revision.

Generated contract format changes and a platform directory reorganization are
outside this work. Model support does not require this project to certify the
accuracy of models selected by users.
