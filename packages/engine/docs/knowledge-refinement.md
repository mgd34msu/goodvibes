# Knowledge refinement

Knowledge refinement is a base knowledge capability. Home Graph uses it through
an extension; it is not a separate refinement system.

## Lifecycle

1. Source ingestion or an Ask detects a gap.
2. The base knowledge service classifies whether the gap is intrinsic to the
   subject and safe to repair.
3. A durable refinement task records the gap, subject, trigger, budget, trace,
   accepted and rejected sources, and retry state.
4. Search and source evaluation prefer official/vendor and high-confidence
   sources, including already-indexed accepted sources.
5. Extraction promotes only useful subject-linked facts.
6. Answer synthesis and generated pages read promoted facts and fact-source
   edges.
7. The task closes after usable evidence was applied, or when the classifier
   finds the gap already repaired. When repair cannot finish it is not given a
   `deferred` state: the task is `blocked` with `retryable: true` and
   `nextRepairAttemptAt` (epoch milliseconds), so list `state=blocked` to find
   work waiting for a retry. A gap held by a model reading while it is prepared
   (for example an uncertain subject choice) writes nothing: it is listed in the
   run's `errors` and read again on the next run, and later gaps in the run are
   still processed.

## Ask behavior

Ask may wait for bounded repair when the subject is concrete and the gap is
high-value. When repair was attempted and cannot complete, the answer carries
refinement metadata instead of presenting a complete zero-fact answer. Metadata
is attached only when repair was attempted and produced tasks: an ask with
`autoRepairGaps: false`, or in a runtime with no gap repairer, returns the
answer and its gaps without a `refinement` object.

Returned refinement metadata can include `status` (`not_needed`, `repaired`,
`deferred`, `active` or `incomplete`), repair status, task ids, accepted source
ids, promoted fact count, waited time, defer reason, and next repair attempt
(epoch milliseconds). Home Graph answers add page refresh state
(`pageRefreshRequested`, `pageRefreshed`).

`promotedFactCount` counts useful subject-linked facts established by successfully
completed repair candidates, including existing facts; it is not a count of
database writes. A held candidate contributes zero and reports its per-gap error
without closing the gap. Independently settled promotion or linking passes from
earlier in that candidate remain durable, while the held pass writes nothing. Inspect
the task's failure reason and persisted facts when a repair returns an error.

## Operator surface

Refinement is part of the base knowledge operator contract, not a separate
service. The operator method ids are `knowledge.refinement.run`,
`knowledge.refinement.tasks.list`, `knowledge.refinement.task.get`, and
`knowledge.refinement.task.cancel`, served over `/api/knowledge/refinement/*`:

- `POST /api/knowledge/refinement/run`
- `GET /api/knowledge/refinement/tasks`
- `GET /api/knowledge/refinement/tasks/{id}`
- `POST /api/knowledge/refinement/tasks/{id}/cancel`

Cancel is accepted for a task in any open state (including `failed`, `blocked`
and `verified`). A `closed` or `suppressed` task is a final decision: cancelling
it is refused with HTTP 409 and the code `KNOWLEDGE_REFINEMENT_TASK_REFUSED`,
and the task is left unchanged. A `closed` task stays closed if its gap later
needs repair again; the run reports that gap in `errors` and does not repair it.

Home Graph reuses this same pipeline through its own
`/api/homeassistant/home-graph/refinement/*` routes.

See [Knowledge system](./knowledge.md) for the broader knowledge data model and
operator surface, and [Home Graph extension](./home-graph.md) for the Home
Assistant extension.

## Quality gates

Facts are rejected when they are raw snippets, URL/title-only fragments,
truncated table debris, affiliate/comparison boilerplate, contradicted by a
better source, or not linked to the subject they claim to describe.
