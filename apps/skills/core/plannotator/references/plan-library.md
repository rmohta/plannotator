# Plan Library

The Plan Library keeps plans after a session ends. You reach it through two Inbox tools, `read_planning` and `request_planning`. There is no planning CLI command. With the `plannotator_inbox` tool, set `action` to the tool name. Otherwise use the stdio server `plannotator inbox mcp`. These tools exist only in an Inbox build that includes the Plan Library, and a connection takes effect in the next session.

Rules for every workflow:

- `request_planning` takes one field, `command`, an object with a `type`. Each call returns the new record. Keep its `id`: later commands need it.
- `read_planning` lists Projects, Deliverables, documents, runs, deviations, decisions, and baselines, in pages (`offset`, `limit`, up to 100). It does not list repositories, checkouts, or approvals. If you need one of those IDs and did not create it, ask the person.
- You cannot approve a document, decide a deviation, sign off a review, record merge evidence, or accept a baseline. The call returns `person_decision_required`. The person does these in the Plans window (`plannotator inbox`, then **Plans**). Tell the person what to approve and where.
- A draft grants no permission to implement. Implement only from the pinned context of a run (`read_planning` with `run_id`).
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

Start every session with `read_planning` and no arguments. Create only what it does not show.

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

**1. Draft the plan.** Read the code first. Then save the plan as an `implementation-plan` document. `content` is the full markdown. Tell the person the document ID and ask for approval in the Plans window. Do not implement.

```json
{"type":"createDocument","projectId":"<project id>","deliverableId":"<deliverable id>","kind":"implementation-plan","title":"Idempotency keys for charges","content":"# Plan\n...","linkedDocumentIds":[]}
```

Add a design (`hld`, `lld`, `project-design`, `integration-design`) the same way. Put the Project-level design without `deliverableId`. A plan can name designs in `linkedDocumentIds`.

**2. Revise after feedback.** Get the latest revision (`read_planning` with `revision_id`, or the document's `latestRevisionId`). Send the full new text.

```json
{"type":"reviseDocument","documentId":"<document id>","expectedRevisionId":"<latest revision id>","content":"# Plan v2\n..."}
```

**3. Wait for approval, then start the run.** The person approves the exact revision in the Plans window. A run needs an approved `implementation-plan` under the Deliverable. The person starts it with **Agent context → Start an implementation run**, or gives you the approval ID so you can send:

```json
{"type":"startRun","deliverableId":"<deliverable id>","approvalIds":["<approval id>"],"sessionId":"<your session id>"}
```

Send `startRun` from the worktree where you will implement, after that worktree has a checkout (section C). The run keeps that checkout: the person's code review, the merge check, and deviation notices use it, so parallel runs of one repository stay in their own worktrees. A run that records no checkout (started in the Plans window, or from a folder with no checkout) uses the first checkout bound to the repository.

Then call `read_planning` with `run_id`. It returns the pinned approved text, parent designs, baselines, and accepted deviations. Page with `offset` and `limit` if `nextOffset` is present.

**4. Implement inside the approved scope.** Run the tests for each required level. Do not use text that is not in the pinned context.

**5. Ask before you deviate.** If the approved text cannot be followed, stop the affected work and send:

```json
{"type":"requestDeviation","runId":"<run id>","repositoryIds":["<repository id>"],"relevantText":"The approved sentence.","proposedChange":"What you want to do.","reason":"Why.","impact":"Effect on contracts, dependencies, tests, and baselines."}
```

The run is now `paused`. The person decides in the Plans window. Other independent work can go on. To change a pending request, send a new one with `replacesId`. Read the run's decisions with `read_planning`. After an `approved` decision, call this once, then read the run context again before you resume:

```json
{"type":"consumeContinuation","runId":"<run id>","decisionId":"<decision id>","sessionId":"<your session id>"}
```

A result of `continued: false` means it was already used. Do not resume twice.

**6. Record evidence.** Commit first. `patchHash` is the SHA-256 of `git diff --no-ext-diff <baseCommit> <headCommit>`. Give one `criteria` entry for each acceptance criterion, with its exact text, and one `tests` entry for each required level. Every `tests[].target` must equal `target`.

```json
{"type":"recordAlignment","runId":"<run id>","target":{"repositoryId":"<repository id>","baseCommit":"<sha>","headCommit":"<sha>","patchHash":"<sha256>"},"criteria":[{"criterion":"A retried request charges once","result":"covered","locations":["src/charge.ts:42"],"explanation":"Why it is covered."}],"tests":[{"level":"unit","command":"bun test src/charge.test.ts","target":{"repositoryId":"<repository id>","baseCommit":"<sha>","headCommit":"<sha>","patchHash":"<sha256>"},"result":"passed","artifact":"path or URL of the test output"}]}
```

Any new deviation or new alignment makes earlier evidence stale. The person signs off in the Plans window (**Review changes**).

**7. After the merge.** The person records the merge evidence. Then you can propose an update to the service baseline (a `service-baseline` document, created with `serviceId`). The person accepts it.

```json
{"type":"proposeBaseline","serviceId":"orders","documentId":"<baseline document id>","expectedRevisionId":"<current baseline revision id>","proposalRevisionId":"<new revision id>","alignmentId":"<alignment id>","mergeEvidenceId":"<merge id>"}
```

## Link a review to a library document

For a registered Plan Library document, pass `--planning-document <id> --planning-revision <id>` together. These flags apply to plan review or one local markdown or plain-text document in `annotate`. Use the current revision ID from the library. An obsolete revision refuses approval.
