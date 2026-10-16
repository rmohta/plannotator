# Plan Library

The Plan Library keeps plans after a session ends. If the agent shares the local filesystem, use `plannotator planning`.
The CLI reads the local store without a running Inbox. Exact exports write complete revision text to files.
Export commands return file paths and metadata instead of the plan text.

If the CLI cannot access the same store, use the Inbox tools `read_planning` and `request_planning`.
With `plannotator_inbox`, set `action` to the tool name. Otherwise use the stdio server `plannotator inbox mcp`.
These tools require an Inbox build with the Plan Library. A new connection takes effect in the next session.

## Local CLI flow

1. Read discovery records with `plannotator planning list --json`.
2. If the result includes `nextOffset`, read the next page with `--offset <nextOffset>`.
3. Use `--kind repositories`, `--kind documents`, or another collection name to reduce discovery output.
4. For document metadata, use `plannotator planning list --kind documents --json`.
   `show <document-id> --json` includes revision text. Use exports for complete revision content.
5. Export an exact revision or a complete run to a new output path:

```bash
plannotator planning export revision <revision-id> --out /tmp/plan-revision.md --json
plannotator planning export agent Bobby --out /tmp/plan-run-context --json
```

A revision export starts with a provenance header that names the plan ID, the revision ID, the revision number, and the exact `reviseDocument` fields for the next revision. The stored text follows the header unchanged. Re-export with `--bare` for the exact stored text alone.
A run export writes `manifest.json` and complete revision files under `documents/`.
The manifest contains the run state, approvals, decisions, deviations, revision IDs, content hashes, and byte counts.
Both exports refuse an existing output path. The parent directory must exist.
A run export uses one store snapshot without pagination or the context text cap.

6. Read the manifest and every exported revision file before implementation.
7. If a file reader limits its output, read the remaining ranges until the entire file is available.
8. If the run is paused, stop the affected implementation.
9. After an accepted deviation and continuation, export the run again to a new directory.

For commands, save one bare command object to a JSON file. Then run `plannotator planning request <command.json> --json`.
Do not wrap the CLI command in `{"command": ...}`. The MCP tool requires that wrapper.
Run the CLI from the worktree where you will implement. The CLI uses that worktree for checkout identity.
The JSON examples in this guide are bare command objects for either transport.

Rules for every workflow:

- `request_planning` takes one field, `command`, an object with a `type`. Each call returns the new record. Keep its `id`: later commands need it.
- `read_planning` lists repositories, checkouts, Projects, Deliverables, documents, runs, deviations, and decisions in pages (`offset`, `limit`, up to 100). Baselines are returned in full. Discovery includes the latest approval per document, with its approval ID, revision ID, revision number, approver, and conditions. Documents include their latest revision number, approval state, and latestApproval. Older approvals remain in history and existing pinned runs. A newer unapproved draft does not replace the latest approved revision.
- You cannot approve a document, decide a deviation, sign off a review, record merge evidence, or accept a baseline. The call returns `person_decision_required`. The person does these in the Plans window (`plannotator inbox`, then **Plans**). Tell the person what to approve and where.
- A draft grants no permission to implement. Implement only from the pinned context of a run. Prefer a local run export.
- Send commands one at a time. Read errors: `conflict` means the record changed, so read it again and retry.

## A. Terminology

| UI term | The person may say | Meaning |
| --- | --- | --- |
| Project | Epic or feature | The parent business or technical ask. |
| Deliverable | Sub-feature or outcome | A child result with acceptance criteria and required tests. |
| HLD | High-level design | Architecture of a Project, service, or integration. |
| LLD | Low-level design | Detailed design of one Deliverable or component. |
| Implementation plan | Plan | Actions, decisions, acceptance criteria, and tests. The person approves it before you implement. |
| Current system / baseline | Baseline knowledge base | The accepted architecture of a service (`service-baseline` document). |
| Run | Implementation run | One pinned set of approved revisions that you implement. |
| Deviation | Plan change request | You pause affected work and ask before you depart from approved text. |

Document kinds: `project-design`, `hld`, `lld`, `integration-design`, `implementation-plan`, `service-baseline`. Test levels: `unit`, `integration`, `e2e`.

## First-time setup (once per repository and Project)

Start every local session with `plannotator planning list --json`. Read every discovery page before you create missing records.
If the CLI cannot access the store, use `read_planning` with no arguments and read every page.

**B. Create a repository.** A repository is a logical identity, not a folder.

```json
{"type":"createRepository","title":"orders-service","remote":"git@github.com:org/orders-service.git"}
```

**C. Bind a checkout.** This ties the repository to a folder on this machine. Code review and merge evidence read git data from it.

Run this from the repository folder or git worktree where you work. Plannotator sends your working folder with every `request_planning` call and uses its git worktree root, so send no `path`:

```json
{"type":"bindCheckout","repositoryId":"<repository id>"}
```

Each git worktree is its own checkout. For parallel features in one repository, give each worktree its own `bindCheckout` with the same `repositoryId`. Send the command from inside that worktree. A subfolder is fine: the worktree root is bound. A folder that is already bound is refused.

To work on a repository from a folder other than your working folder, set `project_path` on the `request_planning` call. To bind a folder by hand, add `path` (an absolute path) to the command.

To move a folder, send the same command with `checkoutId` set to the existing checkout ID. The planning identity stays the same.

**D. Create a Project** (the epic or feature). Every `repositoryIds` entry must exist.

```json
{"type":"createProject","title":"Reliable order processing","purpose":"Why this work exists.","domain":"payments","repositoryIds":["<repository id>"]}
```

**E. Create a Deliverable** (a sub-feature). Acceptance criteria and test levels drive sign-off: every criterion must be `covered` and every listed level must pass.

```json
{"type":"createDeliverable","projectId":"<project id>","title":"Prevent duplicate charges","acceptanceCriteria":["A retried request charges once","A duplicate is logged"],"requiredTests":["unit","integration","e2e"],"relatedDeliverableIds":[]}
```

## Usual workflow (each new piece of work)

### Build an approved plan

Open an individual implementation plan, then select **Build**.
Copy its prompt into the coding agent session in the target repository.
The prompt names one plan and its exact approved revision.
Build is not available on a Deliverable.
There are no approval checkboxes or manual session fields.

If the plan has no approved revision, stop. Do not create or revise a plan as part of Build.
The agent starts the internal implementation run with that plan's approval ID and its actual session ID.
Parent designs and service baselines remain supporting context.

The **Deviations** section tracks this plan's requests and outcomes.
Requests go to Inbox as decision questions with options and feedback.
The person presses Send to record the Decision and return the answer to the agent.

### Workflow steps

**1. Draft the plan.** Read the code first. Then save the plan as an `implementation-plan` document. `content` is the full markdown. Tell the person the document ID and ask for approval in the Plans window. Do not implement.

```json
{"type":"createDocument","projectId":"<project id>","deliverableId":"<deliverable id>","kind":"implementation-plan","title":"Idempotency keys for charges","content":"# Plan\n...","linkedDocumentIds":[]}
```

Add a design (`hld`, `lld`, `project-design`, `integration-design`) the same way. Put the Project-level design without `deliverableId`. A plan can name designs in `linkedDocumentIds`.

**2. Revise after feedback.** Find the document's `latestRevisionId` with `plannotator planning list --kind documents --json`. Export that revision before you revise it: the provenance header carries the `documentId` and `expectedRevisionId` you must send. Send the full new text, and remove the header from anything you submit.
If the CLI cannot access the store, use `read_planning` with `revision_id`.
For required fields and a complete example, run `plannotator planning help reviseDocument`.

```json
{"type":"reviseDocument","documentId":"<document id>","expectedRevisionId":"<latest revision id>","content":"# Plan v2\n..."}
```

A conflict means the revision changed: read the document again and retry with the new revision ID. The Plan &amp; approve tab also offers a copyable authoring prompt with these exact commands.

**3. Wait for approval, then recover your named assignment.** The person approves the exact revision in the Plans window. A run needs an approved `implementation-plan` under the Deliverable. The person copies the prompt from that plan’s **Build** tab. Use its single approval ID to send:

```json
{"type":"startRun","deliverableId":"<deliverable id>","approvalIds":["<approval id>"],"agentName":"Bobby"}
```

Use the name assigned to your terminal, such as Bobby, John, Rohit, or Jarvis. Implement only the plans assigned to that name and their files. The Build tab saves the assignment and includes the name in the copied prompt. Names are case-insensitive. Repeating `startRun` for the same name and agreement returns the existing assignment, including pending deviations.

One name may hold several assignments: repeat `startRun` with the same `agentName` for each plan's own approval. The Build prompt names the run ID of its plan. When your name holds several assignments, add `runId` to `requestDeviation`, `consumeContinuation`, `recordAlignment`, and `completeRun` (or a `deliverableId` that names exactly one). A name with several assignments is ambiguous without a selector; the error lists your run IDs. Export each assignment by run ID:

```bash
plannotator planning list --kind runs --json
plannotator planning export run <run-id> --out <new-directory> --json
```

Send `startRun` from the worktree where you will implement, after that worktree has a checkout (section C). The run keeps that checkout: the person's code review, the merge check, and deviation notices use it, so parallel runs of one repository stay in their own worktrees. A run that records no checkout (started in the Plans window, or from a folder with no checkout) uses the first checkout bound to the repository.

Then export your assignment with `plannotator planning export agent Bobby --out <new-directory> --json`.
Read `manifest.json` and every revision file before implementation. The export includes the complete pinned context.
If the CLI cannot access the store, call `read_planning` with `agent_name: "Bobby"` or `run_id`. Read every page.
If a context document has `truncated: true`, read its exact revision with `revision_id`. Do not implement from incomplete text.

**4. Implement inside the approved scope.** Run the tests for each required level. Do not use text that is not in the pinned context.

**5. Ask before you deviate.** If the approved text cannot be followed, stop the affected work. Read the command help:

```bash
plannotator planning help requestDeviation
plannotator planning request requestDeviation --help --json
```

The help lists required fields, optional `replacesId`, and a complete example. With several assignments under your name, add `runId` to the command. Save one bare command object to a new JSON file. Submit it with `plannotator planning request <new-command.json> --json`:


```json
{"type":"requestDeviation","agentName":"Bobby","repositoryIds":["<repository id>"],"relevantText":"The approved sentence.","proposedChange":"What you want to do.","reason":"Why.","impact":"Effect on contracts, dependencies, tests, and baselines."}
```

The run is now `paused`. Wait for the person’s sent decision and feedback through Plannotator. Silence, timeouts, saved picks, and approval outside Plannotator grant no permission. Do not implement the proposed change while you wait. The request appears in Inbox with options to approve, request revision, or decline. The person adds feedback and presses Send. The sent answer records a Decision. Export the assignment by agent name to read it, including after a terminal restart. Read the updated run context before continuing. Other independent work can go on. No run ID or session ID is required for build commands. To change a pending request, send a new one with `replacesId`. Read the run's decisions in a new run export, or use `read_planning`. Match the sent decision to the request ID and exact proposal revision. A declined or revision-requested decision does not permit the proposed change. After a matching `approved` decision, read its conditions. Use `plannotator planning help consumeContinuation` for the continuation fields. Submit this command once:

```json
{"type":"consumeContinuation","agentName":"Bobby","decisionId":"<decision id>"}
```

Require `result.continued: true` before you resume the approved change. A result of `continued: false` means it was already used. Do not repeat its actions. If continuation fails or another deviation remains pending, keep affected work paused. Read the updated agreement before you resume. Plannotator refuses completion evidence while work is paused or an approved deviation still needs continuation.

**6. Record evidence, then complete the run.** Commit first. `patchHash` is the SHA-256 of `git diff --no-ext-diff <baseCommit> <headCommit>`. Give one `criteria` entry for each acceptance criterion, with its exact text, and one `tests` entry for each required level. Every `tests[].target` must equal `target`. With several assignments, add `runId`.

```json
{"type":"recordAlignment","agentName":"Bobby","runId":"<run id>","target":{"repositoryId":"<repository id>","baseCommit":"<sha>","headCommit":"<sha>","patchHash":"<sha256>"},"criteria":[{"criterion":"A retried request charges once","result":"covered","locations":["src/charge.ts:42"],"explanation":"Why it is covered."}],"tests":[{"level":"unit","command":"bun test src/charge.test.ts","target":{"repositoryId":"<repository id>","baseCommit":"<sha>","headCommit":"<sha>","patchHash":"<sha256>"},"result":"passed","artifact":"path or URL of the test output"}]}
```

Any new deviation or new alignment makes earlier evidence stale. The person signs off in the Plans window (**Review changes**).

When the evidence is recorded, close the run. The Inbox then tells the person sign-off is awaited. A completed run accepts no further deviations or evidence.

```json
{"type":"completeRun","agentName":"Bobby","runId":"<run id>"}
```

Find your remaining assignments with `plannotator planning list --kind runs --json`: the runs still `active` or `paused`. Work the next one from its own Build prompt.

**7. After the merge.** The person records the merge evidence. Then you can propose an update to the service baseline (a `service-baseline` document, created with `serviceId`). The person accepts it.

```json
{"type":"proposeBaseline","serviceId":"orders","documentId":"<baseline document id>","expectedRevisionId":"<current baseline revision id>","proposalRevisionId":"<new revision id>","alignmentId":"<alignment id>","mergeEvidenceId":"<merge id>"}
```

## Link a review to a library document

For a registered Plan Library document, pass `--planning-document <id> --planning-revision <id>` together. These flags apply to plan review or one local markdown or plain-text document in `annotate`. Use the current revision ID from the library. An obsolete revision refuses approval.
