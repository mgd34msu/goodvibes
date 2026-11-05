# Decision call budgets

Status: implemented in v3 development; release qualification remains in progress.

Operation budgets verify how often application code asks for decisions. They do
not certify the accuracy of Jev or another user-selected decision model. Ordinary
providers add zero Decision Router classifications; provider startup and repeated
model inventory operations make zero decision-model requests. A normal routed
turn classifies once, including subsequent streaming/tool rounds. Uncertainty can
trigger one bounded expansion. These are deterministic regression checks in the
normal engine test suite.

The observe report separates logical decisions, configured-target attempts, and
transport dispatches. A target with no resolved credential or incompatible input
can be rejected locally without a network request. A failover chain remains one
logical reading even if several targets are tried. Duplicate log records sharing
a logical request id do not multiply those volume counts.

Older logs do not establish which target attempts reached fetch. Omitted lineage
and empty legacy lineage remain explicitly unknown. A wire budget cannot pass
when that evidence is incomplete. Reported tokens and costs cover retained usage
from answered calls; usage for failed calls stays unknown, rather than being
certified as zero.

Inspect an existing log with `bun run observe:report --log /path/to/decisions.sqlite
--no-calibration --json`. The existing report command migrates older supported
log schemas when opened, so use a copy when inspecting historical data that must
remain untouched.

For operator-chosen volume limits, pass `--budgets /path/to/budgets.json
--check-volume`. A budget file is an array such as:

```json
[
  {
    "name": "My routing window",
    "battery": "routing.decision-router-category",
    "maxLogicalDecisions": 100,
    "maxWireAttempts": 200
  }
]
```

The example numbers are configurable limits, not product-wide defaults. Narrow
the report with `--since`, `--until`, `--battery` or `--site`; the chosen window
must fit the entry limit for a check to pass. The volume check is independent of
the existing accuracy-floor check and makes no live model calls. A local scheduled
report can inspect that installation's log on its own cadence. GitHub's application
regression tests use synthetic transport fixtures and need no paid endpoint key.
