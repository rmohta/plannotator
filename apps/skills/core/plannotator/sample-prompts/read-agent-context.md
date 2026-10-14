# Read Agent context for an existing run

Paste this prompt into your agent session in the repository where you will work.
Replace `<run ID>` with the implementation run ID from **Plans → Agent context**.
The agent needs the local `plannotator planning` CLI and access to the same Plan Library store.
If local access is unavailable, use the Inbox tool `read_planning`.

```text
Export the pinned context for run <run ID> with plannotator planning export run <run ID> --out <new-directory> --json.
Read manifest.json and every exported revision file in full.
If a file reader limits output, read the remaining ranges.
If the CLI cannot access the store, use read_planning with run_id.
Read every MCP page. If a document is truncated, read its exact revision with revision_id.
Summarize the approved scope, approval conditions, acceptance criteria, required tests, baselines, and accepted deviations.
If the run is paused, explain the pending change and wait before affected implementation.
Do not implement yet.
```

Agent context contains the approved document revisions pinned to the run. A later draft does not replace that context.
