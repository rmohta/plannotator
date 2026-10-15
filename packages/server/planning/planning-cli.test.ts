import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore } from "@plannotator/shared/planning/store";
import { runPlanningCli } from "./planning-cli";

// The Plan Library lives under PLANNOTATOR_DATA_DIR; sandbox it per test so no
// test ever reads or writes the real ~/.plannotator (guide-cli.test.ts pattern).
let dataDir = "";
let workDir = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-planning-cli-data-"));
  workDir = mkdtempSync(join(tmpdir(), "plannotator-planning-cli-work-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

/** Run one `request` from stdin and return its `result` record, failing the test on a refusal. */
async function request(command: unknown, cwd: string = workDir): Promise<Record<string, any>> {
  const result = await runPlanningCli(["request", "-", "--json"], process.env, cwd, {
    stdin: () => JSON.stringify(command),
  });
  if (result.code !== 0) throw new Error(`request failed (${result.code}): ${result.stderr}`);
  return JSON.parse(result.stdout!).result;
}

describe("plannotator planning", () => {
  test("list on an empty store prints every section and empty json", async () => {
    const human = await runPlanningCli(["list"], process.env, workDir);
    expect(human.code).toBe(0);
    for (const header of ["Repositories (0)", "Checkouts (0)", "Projects (0)", "Deliverables (0)", "Documents (0)", "Runs (0)", "Deviations (0)", "Decisions (0)", "Baselines (0)"]) {
      expect(human.stdout).toContain(header);
    }
    const parsed = JSON.parse((await runPlanningCli(["list", "--json"], process.env, workDir)).stdout!.trim());
    expect(parsed).toEqual({ repositories: [], checkouts: [], projects: [], deliverables: [], documents: [], approvals: [], runs: [], deviations: [], decisions: [], baselines: {} });
    // nextOffset is absent when nothing was truncated — callers must not see `nextOffset: undefined`.
    expect("nextOffset" in parsed).toBe(false);
  });

  test("repository and checkout IDs are discoverable with paged lists", async () => {
    const first = await request({ type: "createRepository", title: "First" });
    const second = await request({ type: "createRepository", title: "Second" });
    const checkout = await request({ type: "bindCheckout", repositoryId: first.id });
    const page = await runPlanningCli(["list", "--kind", "repositories", "--limit", "1", "--json"], process.env, workDir);
    expect(page.code).toBe(0);
    expect(JSON.parse(page.stdout!)).toEqual({ repositories: [first], nextOffset: 1 });
    const last = await runPlanningCli(["list", "--kind", "repositories", "--offset", "1", "--limit", "1", "--json"], process.env, workDir);
    expect(JSON.parse(last.stdout!)).toEqual({ repositories: [second] });
    const checkouts = await runPlanningCli(["list", "--kind", "checkouts", "--json"], process.env, workDir);
    expect(checkouts.code).toBe(0);
    expect(JSON.parse(checkouts.stdout!)).toEqual({ checkouts: [checkout] });
    const human = await runPlanningCli(["list", "--kind", "checkouts"], process.env, workDir);
    expect(human.stdout).toContain(checkout.path);
    expect(human.stdout).toContain(first.id);
    const all = JSON.parse((await runPlanningCli(["list", "--limit", "1", "--json"], process.env, workDir)).stdout!);
    expect(all.repositories).toEqual([first]);
    expect(all.checkouts).toEqual([checkout]);
    expect(all.nextOffset).toBe(1);
  });

  test("a full write/read cycle survives stdin, a file, list and show", async () => {
    const repo = await request({ type: "createRepository", title: "Service" });
    // A file resolved against cwd, not just stdin.
    const commandFile = join(workDir, "command.json");
    writeFileSync(commandFile, JSON.stringify({ type: "createProject", title: "Feature", purpose: "Durable outcome", repositoryIds: [repo.id] }));
    const fileRun = await runPlanningCli(["request", "command.json", "--json"], process.env, workDir);
    expect(fileRun.code).toBe(0);
    const project = JSON.parse(fileRun.stdout!).result;

    const listing = JSON.parse((await runPlanningCli(["list", "--kind", "projects", "--json"], process.env, workDir)).stdout!.trim());
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0].title).toBe("Feature");
    expect("nextOffset" in listing).toBe(false);

    // A non-document record prints key: value lines and never a revision list.
    const projectShown = await runPlanningCli(["show", project.id], process.env, workDir);
    expect(projectShown.code).toBe(0);
    expect(projectShown.stdout).toContain("title: Feature");
    expect(projectShown.stdout).not.toContain("Revisions (");

    const doc = await request({ type: "createDocument", projectId: project.id, title: "Plan", kind: "implementation-plan", content: "# First" });
    const draft = await request({ type: "reviseDocument", documentId: doc.id, expectedRevisionId: doc.latestRevisionId, content: "# Second" });

    const documents = await runPlanningCli(["list", "--kind", "documents"], process.env, workDir);
    expect(documents.stdout).toContain(`[${doc.kind}] rev ${String(draft.latestRevisionId).slice(-8)}`);
    // `show` prints the LATEST revision's content with the revision list newest last.
    const shown = await runPlanningCli(["show", doc.id], process.env, workDir);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Revisions (2)");
    expect(shown.stdout!.indexOf(String(doc.latestRevisionId))).toBeLessThan(shown.stdout!.indexOf(String(draft.latestRevisionId)));
    expect(shown.stdout).toContain("# Second");
    expect(shown.stdout).not.toContain("# First");
    // --revision pins an older one; an unknown revision of that document is not_found.
    expect((await runPlanningCli(["show", doc.id, "--revision", String(doc.latestRevisionId)], process.env, workDir)).stdout).toContain("# First");
    const badRevision = await runPlanningCli(["show", doc.id, "--revision", "nope"], process.env, workDir);
    expect(badRevision.code).toBe(1);
    expect(badRevision.stderr).toContain("not_found");
    // A bare revision id prints that revision's content; --json mirrors the HTTP route's { document, revisions }.
    expect((await runPlanningCli(["show", String(doc.latestRevisionId)], process.env, workDir)).stdout).toContain("# First");
    const docJson = JSON.parse((await runPlanningCli(["show", doc.id, "--json"], process.env, workDir)).stdout!.trim());
    expect(docJson.document.id).toBe(doc.id);
    expect(docJson.revisions).toHaveLength(2);
    // A missing record is not_found with the id on stderr.
    const missing = await runPlanningCli(["show", "nope"], process.env, workDir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not_found: no planning record nope");
  });

  test("request refuses every person-decision command and writes nothing", async () => {
    // A person decision through the CLI would bypass the Plans window; each of
    // the five types must be refused before the store is touched.
    for (const type of ["approveDocument", "decideDeviation", "signoffAlignment", "acceptBaseline", "recordMerge"]) {
      const result = await runPlanningCli(["request", "-"], process.env, workDir, { stdin: () => JSON.stringify({ type, documentId: "x" }) });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "person_decision_required: Only the person can approve, decide a deviation, sign off, accept a baseline or record merge evidence. Do it in the Plans window (plannotator inbox, then Plans).\n",
      );
    }
    const state = await new PlanningStore({ dataDir }).read();
    expect(state.projects).toHaveLength(0);
    expect(state.approvals).toHaveLength(0);
    expect(existsSync(join(dataDir, "planning"))).toBe(false);
  });

  test("request stamps checkoutPath from its cwd and drops a caller-supplied one", async () => {
    const repo = await request({ type: "createRepository", title: "Service" });
    // A non-git cwd falls back to realpath(cwd) — never the path the command claimed.
    const claimed = join(workDir, "claimed-checkout");
    const bound = await request({ type: "bindCheckout", repositoryId: repo.id, checkoutPath: claimed });
    expect(bound.path).toBe(realpathSync(workDir));

    // A git worktree stamps the toplevel git reports (either path spelling on macOS).
    const gitDir = mkdtempSync(join(tmpdir(), "plannotator-planning-cli-git-"));
    try {
      execFileSync("git", ["init", "--quiet", "."], { cwd: gitDir, stdio: "ignore" });
      const fromRepo = await request({ type: "bindCheckout", repositoryId: repo.id, checkoutPath: claimed }, gitDir);
      expect([gitDir, realpathSync(gitDir)]).toContain(fromRepo.path);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  test("usage mistakes exit 2 and unknown commands exit 1", async () => {
    expect((await runPlanningCli([], process.env, workDir)).code).toBe(2);
    const unknownSub = await runPlanningCli(["frobnicate"], process.env, workDir);
    expect(unknownSub.code).toBe(2);
    expect(unknownSub.stderr).toContain("Usage:");
    expect((await runPlanningCli(["list", "--bogus"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["list", "--kind", "nope"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["list", "--limit", "0"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["list", "--limit", "101"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["list", "--offset", "-1"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["show"], process.env, workDir)).code).toBe(2);
    expect((await runPlanningCli(["request"], process.env, workDir)).code).toBe(2);

    const badJson = await runPlanningCli(["request", "-"], process.env, workDir, { stdin: () => "{not json" });
    expect(badJson.code).toBe(2);
    expect(badJson.stderr).toContain("not valid JSON");
    const notObject = await runPlanningCli(["request", "-"], process.env, workDir, { stdin: () => "[1]" });
    expect(notObject.code).toBe(2);
    const absentFile = await runPlanningCli(["request", join(workDir, "absent.json")], process.env, workDir);
    expect(absentFile.code).toBe(2);

    const unknownType = await runPlanningCli(["request", "-"], process.env, workDir, { stdin: () => JSON.stringify({ type: "destroyEverything" }) });
    expect(unknownType.code).toBe(1);
    expect(unknownType.stderr).toContain("validation_error");
    // Store-level validation failures carry the store's own code.
    const invalid = await runPlanningCli(["request", "-"], process.env, workDir, { stdin: () => JSON.stringify({ type: "createProject", title: "No purpose", repositoryIds: [] }) });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("invalid_request: purpose must be a nonempty string");
  });

  test("context prints the pinned run agreement", async () => {
    const repo = await request({ type: "createRepository", title: "Service" });
    const project = await request({ type: "createProject", title: "Feature", purpose: "Correct behavior", repositoryIds: [repo.id] });
    const deliverable = await request({ type: "createDeliverable", projectId: project.id, title: "Outcome", acceptanceCriteria: ["Correct"], requiredTests: ["unit"] });
    const doc = await request({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: "Plan", kind: "implementation-plan", content: "Original" });
    // The person approval is executed directly against the store (only the CLI refuses it).
    const approval = await new PlanningStore({ dataDir }).execute({
      type: "approveDocument", documentId: doc.id, expectedRevisionId: doc.latestRevisionId, person: "Person",
    });
    const run = await request({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], agentName: "session" });

    const human = await runPlanningCli(["context", run.agentName], process.env, workDir);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Feature");
    expect(human.stdout).toContain("Plan (implementation-plan, revision ");
    expect(human.stdout).toContain("Original");

    const json = JSON.parse((await runPlanningCli(["context", run.agentName, "--json"], process.env, workDir)).stdout!.trim());
    expect(json.run.state).toBe("active");
    expect(json.documents[0].revision.content).toBe("Original");

    // The approval the run pinned is addressable through show too.
    const approvalShown = await runPlanningCli(["show", approval.id], process.env, workDir);
    expect(approvalShown.stdout).toContain("person: Person");

    const missing = await runPlanningCli(["context", "nope"], process.env, workDir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not_found");
  });

  test("revision export preserves exact UTF-8 content and refuses overwrites", async () => {
    const store = new PlanningStore({ dataDir });
    const project = await store.execute({ type: "createProject", title: "P", purpose: "p", repositoryIds: [] });
    const content = "# Exact\r\n" + "日本語🙂".repeat(24000) + "tail without newline";
    const document = await store.execute({ type: "createDocument", projectId: project.id, title: "Plan", kind: "implementation-plan", content });
    const result = await runPlanningCli(["export", "revision", document.latestRevisionId, "--out", "plan.md", "--json"], process.env, workDir);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout!);
    expect(summary.path).toBe(join(workDir, "plan.md"));
    expect(summary.bytes).toBe(Buffer.byteLength(content));
    expect(readFileSync(summary.path, "utf8")).toBe(content);
    expect(result.stdout!.length).toBeLessThan(600);
    const repeated = await runPlanningCli(["export", "revision", document.latestRevisionId, "--out", "plan.md"], process.env, workDir);
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toContain("EEXIST");
    expect(readFileSync(summary.path, "utf8")).toBe(content);
  });

  test("run export includes all pinned revisions beyond paging and text caps, with agreement metadata", async () => {
    const store = new PlanningStore({ dataDir });
    const project = await store.execute({ type: "createProject", title: "P", purpose: "p", repositoryIds: [] });
    const deliverable = await store.execute({ type: "createDeliverable", projectId: project.id, title: "D", acceptanceCriteria: ["works"], requiredTests: [] });
    const approvals = [];
    for (let index = 0; index < 21; index++) {
      const document = await store.execute({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: `Plan ${index}`, kind: index === 0 ? "implementation-plan" : "hld", content: `${index}:` + "🙂".repeat(6000) });
      approvals.push(await store.execute({ type: "approveDocument", documentId: document.id, expectedRevisionId: document.latestRevisionId, person: "Person" }));
    }
    const run = await store.execute({ type: "startRun", deliverableId: deliverable.id, approvalIds: approvals.map(row => row.id), agentName: "session" });
    const deviation = await store.execute({ type: "requestDeviation", agentName: run.agentName, repositoryIds: [], relevantText: "old", proposedChange: "new", reason: "needed", impact: "small" });
    const decision = await store.execute({ type: "decideDeviation", requestId: deviation.id, expectedProposalRevision: 1, action: "approved", person: "Person", conditions: "verify" });
    const firstDocument = (await store.read()).documents[0];
    await store.execute({ type: "reviseDocument", documentId: firstDocument.id, expectedRevisionId: firstDocument.latestRevisionId!, content: "Unapproved replacement" });
    const result = await runPlanningCli(["export", "agent", run.agentName, "--out", "context", "--json"], process.env, workDir);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout!);
    expect(summary.revisionCount).toBe(21);
    const manifest = JSON.parse(readFileSync(summary.manifestPath, "utf8"));
    expect(manifest.run.revisionIds).toEqual(run.revisionIds);
    expect(manifest.approvals).toEqual(approvals);
    expect(manifest.decisions).toEqual([decision]);
    expect(manifest.acceptedDeviations[0].id).toBe(deviation.id);
    expect(manifest.run.state).toBe("active");
    const state = await store.read();
    for (const entry of manifest.documents) {
      const original = state.revisions.find(row => row.id === entry.revision.id)!;
      const exported = readFileSync(join(summary.path, entry.revision.file));
      expect(exported.toString("utf8")).toBe(original.content);
      expect(exported.byteLength).toBe(entry.revision.bytes);
      expect(entry.revision.contentHash).toBe(original.contentHash);
      expect(entry.revision.content).toBeUndefined();
    }
    expect(result.stdout!.length).toBeLessThan(600);
    expect((await runPlanningCli(["export", "agent", run.agentName, "--out", "context"], process.env, workDir)).code).toBe(1);
    expect(JSON.parse(readFileSync(summary.manifestPath, "utf8")).documents).toHaveLength(21);
  });

  test("export refuses corrupted revision hashes before creating output", async () => {
    const store = new PlanningStore({ dataDir });
    const project = await store.execute({ type: "createProject", title: "P", purpose: "p", repositoryIds: [] });
    const deliverable = await store.execute({ type: "createDeliverable", projectId: project.id, title: "D", acceptanceCriteria: [], requiredTests: [] });
    const document = await store.execute({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: "Plan", kind: "implementation-plan", content: "Original" });
    const approval = await store.execute({ type: "approveDocument", documentId: document.id, expectedRevisionId: document.latestRevisionId, person: "Person" });
    const run = await store.execute({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], agentName: "session" });
    const state = await store.read();
    state.revisions[0].content = "Corrupted";
    writeFileSync(join(dataDir, "planning", "state.json"), JSON.stringify(state));
    for (const [kind, id] of [["revision", document.latestRevisionId], ["run", run.id]]) {
      const result = await runPlanningCli(["export", kind, id, "--out", "output"], process.env, workDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("integrity_error");
      expect(existsSync(join(workDir, "output"))).toBe(false);
    }
  });

  test("export usage and missing records leave no output", async () => {
    for (const args of [["export"], ["export", "run", "x"], ["export", "revision", "x", "--out"], ["export", "document", "x", "--out", "output"], ["export", "run", "x", "--out", "output", "--limit", "1"]]) {
      expect((await runPlanningCli(args, process.env, workDir)).code).toBe(2);
    }
    for (const kind of ["revision", "run"]) {
      const result = await runPlanningCli(["export", kind, "unknown", "--out", "output"], process.env, workDir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not_found");
      expect(existsSync(join(workDir, "output"))).toBe(false);
    }
  });

  test("a request without a running Inbox succeeds quietly", async () => {
    // No inbox/inbox.json exists in the temp data dir, so the delivery poke
    // must not run and must not warn: the next Inbox start syncs anyway.
    const result = await runPlanningCli(["request", "-"], process.env, workDir, {
      stdin: () => JSON.stringify({ type: "createProject", title: "Quiet", purpose: "p", repositoryIds: [] }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr ?? "").not.toContain("sync");
  });

  test("an idempotent replay returns the stored record and writes nothing new", async () => {
    const command = { type: "createProject", title: "Once", purpose: "p", repositoryIds: [], idempotencyKey: "once" };
    const first = await request(command);
    const second = await request(command);
    expect(second.id).toBe(first.id);
    expect((await new PlanningStore({ dataDir }).read()).projects).toHaveLength(1);
  });
});

// Approval IDs, revision numbers and conditions must be discoverable without an Inbox.
test('CLI discovery identifies the latest approval even when the latest revision is a draft', async () => {
 const store = new PlanningStore({ dataDir });
 const project = await store.execute({ type: 'createProject', title: 'Feature', purpose: 'Test', repositoryIds: [] });
 const document = await store.execute({ type: 'createDocument', title: 'Plan', projectId: project.id, kind: 'implementation-plan', content: 'One' });
 await store.execute({ type: 'approveDocument', documentId: document.id, expectedRevisionId: document.latestRevisionId, person: 'Person' });
 const revised = await store.execute({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: document.latestRevisionId, content: 'Two' });
 const approval = await store.execute({ type: 'approveDocument', documentId: document.id, expectedRevisionId: revised.latestRevisionId, person: 'Reviewer', notes: 'Run integration tests' });
 await store.execute({ type: 'reviseDocument', documentId: document.id, expectedRevisionId: approval.revisionId, content: 'Three' });
 const shape = JSON.parse((await runPlanningCli(['list', '--json'], process.env, workDir)).stdout!);
 expect(shape.approvals).toHaveLength(1);
 expect(shape.approvals[0]).toMatchObject({ ...approval, revisionNumber: 2 });
 expect(shape.documents[0]).toMatchObject({ latestRevisionNumber: 3, approvalState: 'draft', latestApproval: { ...approval, revisionNumber: 2 } });
 const human = await runPlanningCli(['list', '--kind', 'approvals'], process.env, workDir);
 expect(human.stdout).toContain('Revision 2');
 expect(human.stdout).toContain(approval.id);
 expect(human.stdout).toContain(approval.revisionId);
 expect(human.stdout).toContain(approval.notes);
});

test('named agents recover independent plan assignments and deviations through the CLI', async () => {
  const store = new PlanningStore({ dataDir });
  const project = await request({ type: 'createProject', title: 'Factory', purpose: 'Independent plans', repositoryIds: [] });
  const assignments = [];
  for (const agentName of ['Bobby', 'John', 'Rohit', 'Jarvis']) {
    const deliverable = await request({ type: 'createDeliverable', projectId: project.id, title: agentName, acceptanceCriteria: ['Works'], requiredTests: [] });
    const plan = await request({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: `${agentName} plan`, kind: 'implementation-plan', content: `Only ${agentName}'s file` });
    const approval = await store.execute({ type: 'approveDocument', documentId: plan.id, expectedRevisionId: plan.latestRevisionId, person: 'Reviewer' });
    const command = { type: 'startRun', agentName, deliverableId: deliverable.id, approvalIds: [approval.id] };
    const assigned = await request(command);
    assignments.push({ command, assigned });
    const recovered = await request({ ...command, agentName: agentName.toLowerCase() });
    expect(recovered.id).toBe(assigned.id);
    const exported = await runPlanningCli(['export', 'agent', agentName, '--out', agentName, '--json'], process.env, workDir);
    expect(exported.code).toBe(0);
    const output = JSON.parse(exported.stdout!);
    const manifest = JSON.parse(readFileSync(output.manifestPath, 'utf8'));
    expect(manifest.run.agentName).toBe(agentName);
    expect(readFileSync(join(output.path, manifest.documents[0].revision.file), 'utf8')).toBe(`Only ${agentName}'s file`);
  }
  const deviation = await request({ type: 'requestDeviation', agentName: 'Bobby', repositoryIds: [], relevantText: 'Original', proposedChange: 'Change', reason: 'Needed', impact: 'Tests' });
  const restart = new PlanningStore({ dataDir });
  expect((await restart.context('Bobby')).run.state).toBe('paused');
  expect((await restart.context('John')).run.state).toBe('active');
  expect((await request(assignments[0].command)).state).toBe('paused');
  expect((await restart.read()).runs).toHaveLength(4);
  await expect(request({ ...assignments[0].command, agentName: 'Replacement' })).rejects.toThrow('pending deviations');
  await expect(request({ ...assignments[1].command, agentName: 'Bobby' })).rejects.toThrow('already assigned');
  const decision = await restart.execute({ type: 'decideDeviation', requestId: deviation.id, expectedProposalRevision: 1, action: 'approved', person: 'Reviewer' });
  await expect(request({ type: 'consumeContinuation', agentName: 'John', decisionId: decision.id })).rejects.toThrow('not authorized');
  expect((await request({ type: 'consumeContinuation', agentName: 'Bobby', decisionId: decision.id })).continued).toBe(true);
  expect((await request({ type: 'consumeContinuation', agentName: 'Bobby', decisionId: decision.id })).continued).toBe(false);
  await expect(request({ type: 'startRun', deliverableId: assignments[0].command.deliverableId, approvalIds: assignments[0].command.approvalIds, sessionId: 'old-session' })).rejects.toThrow('agentName');
  await expect(request({ type: 'requestDeviation', runId: assignments[0].assigned.id, repositoryIds: [], relevantText: 'x', proposedChange: 'y', reason: 'z', impact: 'Tests' })).rejects.toThrow('agentName');
  const unknown = await runPlanningCli(['export', 'agent', 'Unknown', '--out', 'missing'], process.env, workDir);
  expect(unknown.code).toBe(1);
  expect(existsSync(join(workDir, 'missing'))).toBe(false);
});

test('command help is available without reading stdin or creating planning records', async () => {
  const io = { stdin: () => { throw new Error('Help must not read stdin'); } };
  for (const args of [
    ['--help'], ['request', '--help'], ['help', 'requestDeviation'],
    ['request', 'requestDeviation', '--help'], ['help', 'consumeContinuation'],
    ['request', 'consumeContinuation', '-h'],
  ]) {
    const result = await runPlanningCli(args, process.env, workDir, io);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('requestDeviation');
    expect(result.stderr).toBeUndefined();
  }
  expect(existsSync(join(dataDir, 'planning'))).toBe(false);
  const unknown = await runPlanningCli(['help', 'notACommand'], process.env, workDir, io);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain('requestDeviation');
});

test('CLI help examples submit a deviation but cannot continue or record evidence without a Plannotator approval', async () => {
  const help = JSON.parse((await runPlanningCli(['request', 'requestDeviation', '--help', '--json'], process.env, workDir)).stdout!);
  const continuation = JSON.parse((await runPlanningCli(['help', 'consumeContinuation', '--json'], process.env, workDir)).stdout!);
  const store = new PlanningStore({ dataDir });
  const repo = await request({ type: 'createRepository', title: 'Service' });
  const project = await request({ type: 'createProject', title: 'Feature', purpose: 'Correct behavior', repositoryIds: [repo.id] });
  const deliverable = await request({ type: 'createDeliverable', projectId: project.id, title: 'Outcome', acceptanceCriteria: ['Correct'], requiredTests: [] });
  const plan = await request({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: 'Plan', kind: 'implementation-plan', content: 'Original agreement' });
  const approval = await store.execute({ type: 'approveDocument', documentId: plan.id, expectedRevisionId: plan.latestRevisionId, person: 'Reviewer' });
  await request({ type: 'startRun', agentName: 'Bobby', deliverableId: deliverable.id, approvalIds: [approval.id] });
  const proposal = { ...help.example, agentName: 'Bobby', repositoryIds: [repo.id], relevantText: 'Original agreement', proposedChange: 'Updated agreement', reason: 'Missing case', impact: 'Update tests' };
  const submitted = await runPlanningCli(['request', '-', '--json'], process.env, workDir, { stdin: () => JSON.stringify(proposal) });
  expect(submitted.code, submitted.stderr).toBe(0);
  const { result: deviation, nextSteps } = JSON.parse(submitted.stdout!);
  expect(nextSteps.join('\n')).toContain('consumeContinuation');
  const evidence = { type: 'recordAlignment', agentName: 'Bobby', target: { repositoryId: repo.id, baseCommit: 'base', headCommit: 'head', patchHash: 'patch' }, criteria: [], tests: [] };
  await expect(request(evidence)).rejects.toThrow('consumeContinuation');
  await expect(request({ ...continuation.example, agentName: 'Bobby', decisionId: 'unsent-or-invented' })).rejects.toThrow('Unknown record');
  // Even a durable approval needs the explicit continuation step before evidence can claim completion.
  const decision = await store.execute({ type: 'decideDeviation', requestId: deviation.id, expectedProposalRevision: deviation.proposalRevision, action: 'approved', person: 'Reviewer', conditions: 'Preserve the API' });
  await expect(request(evidence)).rejects.toThrow('consumeContinuation');
  const exported = await runPlanningCli(['export', 'agent', 'Bobby', '--out', 'decision', '--json'], process.env, workDir);
  const manifest = JSON.parse(readFileSync(JSON.parse(exported.stdout!).manifestPath, 'utf8'));
  expect(manifest.decisions[0].conditions).toBe('Preserve the API');
  const consumed = await request({ ...continuation.example, agentName: 'Bobby', decisionId: manifest.decisions[0].id });
  expect(consumed.continued).toBe(true);
  expect((await request(evidence)).decisionIds).toContain(decision.id);
});

test('assignment exports retain Plannotator refusals and feedback without granting continuation', async () => {
  const store = new PlanningStore({ dataDir });
  const project = await request({ type: 'createProject', title: 'Feature', purpose: 'Approval gate', repositoryIds: [] });
  const deliverable = await request({ type: 'createDeliverable', projectId: project.id, title: 'Outcome', acceptanceCriteria: [], requiredTests: [] });
  const plan = await request({ type: 'createDocument', projectId: project.id, deliverableId: deliverable.id, title: 'Plan', kind: 'implementation-plan', content: 'Approved scope' });
  const approval = await store.execute({ type: 'approveDocument', documentId: plan.id, expectedRevisionId: plan.latestRevisionId, person: 'Reviewer' });
  await request({ type: 'startRun', agentName: 'Jarvis', deliverableId: deliverable.id, approvalIds: [approval.id] });
  for (const action of ['declined', 'revision-requested'] as const) {
    const deviation = await request({ type: 'requestDeviation', agentName: 'Jarvis', repositoryIds: [], relevantText: 'Approved scope', proposedChange: 'Different scope', reason: 'Request', impact: 'Tests' });
    const decision = await store.execute({ type: 'decideDeviation', requestId: deviation.id, expectedProposalRevision: 1, action, person: 'Reviewer', conditions: 'Keep the original API' });
    const exported = await runPlanningCli(['export', 'agent', 'Jarvis', '--out', action, '--json'], process.env, workDir);
    const manifest = JSON.parse(readFileSync(JSON.parse(exported.stdout!).manifestPath, 'utf8'));
    expect(manifest.decisions.find((entry: { id: string }) => entry.id === decision.id)).toMatchObject({ action, conditions: 'Keep the original API' });
    expect(manifest.run.decisionIds).not.toContain(decision.id);
    await expect(request({ type: 'consumeContinuation', agentName: 'Jarvis', decisionId: decision.id })).rejects.toThrow('not authorized');
  }
});
