# Read Agent context for an existing run

Paste this prompt into your agent session in the repository where you will work.
Replace `<run ID>` with the implementation run ID from **Plans → Agent context**.
The agent needs the Inbox tool `read_planning`, or the corresponding `plannotator_inbox` action.

```text
Read the pinned context for run <run ID> with read_planning and run_id.
Read all pages if nextOffset is present.
Summarize the approved scope, approval conditions, acceptance criteria, required tests, baselines, and accepted deviations.
If the run is paused, explain the pending change and wait before affected implementation.
Do not implement yet.
```

Agent context contains the approved document revisions pinned to the run. A later draft does not replace that context.
