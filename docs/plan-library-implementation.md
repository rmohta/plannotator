# Plan Library implementation

The Inbox has a permanent **Plans** area at `#plans`.
Projects identify requested outcomes; repository records identify source code.
Checkout bindings identify local paths without changing either identity.
A repository can have many checkouts, one per git worktree, so parallel features can build in separate worktrees.
The existing prototype and proposal remain separate from this implementation.

## Storage decision

`PlanningStore` stores records under `<data directory>/planning/state.json`.
The store preserves revisions and decisions in the record history.
Each revision has a UUID, exact content, predecessor, and SHA-256 hash.

Writers claim an exclusive hard link to a complete owner record before they read state.
A writer uses an exclusive temporary file, file synchronization, atomic rename, and directory synchronization.
Readers therefore see a complete state before or after a transaction.

The store recovers a lock only when its owner process no longer exists.
Recovery uses an inode-specific claim and checks the inode before deletion.
Contention returns a conflict after ten seconds; lock age alone grants no recovery permission.
The storage format requires a local filesystem with hard-link and atomic-rename support.

## Agreements and decisions

An approval identifies one immutable revision and records separate approval notes.
Direct edits produce a complete new revision before approval.
An implementation run pins its approved documents, parent designs, linked documents, and accepted baselines.
New drafts and later approvals do not replace these references.

A deviation request pauses the run before the agent can consume continuation permission.
Only explicit approval adds the exact proposal to the agreement.
Revision requests, conversation replies, conversation archives, and timeouts grant no planning permission.
A replacement proposal needs its own decision.

Planning decisions become durable before the Inbox sends attention messages and person replies.
The delivery path uses the existing host reply bridge.
Startup repairs missing deliveries from durable planning records.
Idempotency keys prevent duplicate messages and replies.

An agent reads the latest pinned context before continuation.
`consumeContinuation` checks the run, decision, requesting session, and active state.
It grants each continuation once.
Other pending deviation requests retain the paused state.

A restarted host reads the durable agreement and retains the requesting session identity.
If that host cannot receive automatic replies, it uses the normal Inbox transport to read the decision.
These controls require the agent to obey the agreement; they cannot intercept arbitrary shell commands or file writes.

## Agent access

The existing `plannotator_inbox` tool exposes `read_planning` and `request_planning`.
The MCP server exposes the same operations.
The registered tool list remains fixed for each host session.
`plannotator planning help` lists every agent command type with its description and the person-only commands; every topic returns required fields, optional fields, a complete example, and next steps.
The accepted command set derives from the same catalog (`packages/core/planning-command-help.ts`), so help and validation cannot drift apart.
Discovery returns bounded metadata; document and revision reads return exact stored content.
A revision export prepends a provenance header naming the document and revision, with the exact `reviseDocument` fields; `--bare` restores the exact stored text.
Run context supports pagination and a total content limit.

For a registered local text document, pass both identity flags:

```sh
plannotator annotate design.md --planning-document <document-id> --planning-revision <revision-id>
```

The CLI refuses an obsolete revision or an incomplete pair of flags.
The plan-review entrypoints accept the same flags.
The approval archive records the submitted revision and the actual approved revision.

Agent operations cannot approve documents, decide deviations, sign off code, record a merge, or accept a baseline.
Person decisions use the current browser session and the existing origin checks.
The interface and agent transports use the same planning store.

One agent name may hold several assignments.
Run-scoped agent commands (`requestDeviation`, `consumeContinuation`, `recordAlignment`, `completeRun`) select one assignment with `runId`, or a `deliverableId` that names exactly one; an ambiguous name fails with the run IDs.
`completeRun` closes a run after alignment evidence exists; the delivery sync sends the person one sign-off notice per completed run.
A completed run accepts no new deviations or evidence, and the person can still sign off.

## Review and baseline evidence

The Plans area opens the existing review application with a frozen patch and agreement.
Bun and Pi reviews expose the same agreement snapshot.
Review prompts include the pinned revisions, approval notes, accepted proposals, acceptance criteria, and required test levels.
The alignment display remains separate from Guided Review reading progress.

Criterion evidence records Covered, Missing, Deviation, or Unknown.
Test evidence identifies the command, exact code target, result, and artifact reference.
The test recorder must retain actual execution evidence; a test file alone does not prove success.
Unresolved criteria, absent passing test results, or pending deviations prevent signoff.
A later alignment target makes the earlier signoff stale.

Merge evidence uses the checkout of the run under review and an actual target branch reference.

## Worktrees
Every `request_planning` call carries the agent's working folder (`project_path`).
The Inbox resolves it to the git worktree root and stamps it on the command as `checkoutPath`; an agent cannot set `checkoutPath` itself.
`bindCheckout` without `path` binds that worktree root. A path that is already bound is refused.
`startRun` records the checkout whose path matches (compared by real path) as the run's `checkoutId`.
Code review, merge evidence, and deviation notices use the run's checkout.
A run with no recorded checkout (started in the Plans window, from an unbound folder, or before this field existed) uses the first checkout bound to the repository.

The server checks the resulting target commit and the committed reviewed patch.
Squash and rebase outcomes require exact patch equivalence when commit ancestry differs.
Unavailable or different evidence prevents baseline promotion.
Remote forge evidence without a local checkout is not a supported source.

Baseline acceptance checks the expected current revision and the accepted delivery evidence.
A concurrent pointer change refuses an obsolete proposal.
The store keeps earlier revisions readable for existing runs.

## Interface reuse

The Plans area uses the existing Viewer, MarkdownEditor, MarkdownDiff, theme, and document controls.
It provides the complete terminology table from the proposal.
Existing conversation Projects retain their repository-folder meaning.
Existing plan, annotate, and review sessions retain their defaults when no planning identity is supplied.

## Verification

Unit tests cover immutable content, obsolete decisions, concurrent subprocess writers, lock recovery, and baseline conflicts.
Integration tests cover durable decisions, restart repair, duplicate delivery, pinned context, and continuation permission.
Bun and Pi tests cover registered plan approvals, annotate approvals, denied plans, host closure, and review snapshots.

Browser tests use scratch storage and a real git repository.
They cover direct edits, approvals, deviations, real review launch, stale signoff, verified merge evidence, baseline acceptance, and reload persistence.
