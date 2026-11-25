# How work is kept

The daemon keeps the work of the project it serves: each piece of work with its goal and what done means (kept exactly as written), its attempts, the evidence that it was checked, and every change as a numbered event. The terminal app, the Agent, the web UI and a script read the same record (`work.list`), so they never disagree about where a piece of work stands.

Where it stands, whether it was checked, how far its run got and whether it needs to be resumed are each shown as they are; one is never taken for another. When an answer from the daemon is lost, the result is unknown until it is read again, which the Work place does by itself.

Work brought in from old planning records is kept as history: it is shown in the Work place's History list with what it asked for and what done meant, and it never runs by itself.

The Work place, its keys and the setting "Show me the plan before it runs" are described in [Work](native-work.md).
