/**
 * Parallel features in one repository: each git worktree is its own checkout.
 * Agents in the main folder and in a linked worktree (the Pi / OpenCode
 * connection, against a real Inbox in this process) send request_planning
 * from their working folders; the Inbox binds and runs each against the
 * worktree root git reports, never against the first folder bound.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInboxTools, InboxAgentConnection } from "@plannotator/shared/inbox/agent-link";
import type { PlanningState } from "@plannotator/core/planning-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
}

test("each worktree binds as its own checkout and a run records the worktree it started in", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-planning-worktree-")));
  roots.push(root);
  const main = join(root, "orders");
  const feature = join(root, "orders-feature");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "feature", feature);
  mkdirSync(join(feature, "src"));

  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: (await discoverInboxTools(dataDir))!, command: "/nonexistent" });
  const planning = async (command: Record<string, unknown>, cwd: string) => {
    const answer = await connection.callTool({ action: "request_planning", command }, { sessionId: "ses_a", cwd });
    expect(answer.isError).toBe(false);
    return (JSON.parse(answer.text.slice(answer.text.indexOf("{"))) as { result: Record<string, any> }).result;
  };
  const snapshot = async () => (await (await fetch(`${base}/api/inbox/planning`)).json()) as { serverSession: string; state: PlanningState };

  const repo = await planning({ type: "createRepository", title: "Orders" }, main);
  // No path: the Inbox binds the worktree root of the folder the agent works in, even from a subfolder.
  const mainCheckout = await planning({ type: "bindCheckout", repositoryId: repo.id }, main);
  const featureCheckout = await planning({ type: "bindCheckout", repositoryId: repo.id }, join(feature, "src"));
  expect(mainCheckout.path).toBe(main);
  expect(featureCheckout.path).toBe(feature);
  expect(featureCheckout.repositoryId).toBe(mainCheckout.repositoryId);

  const project = await planning({ type: "createProject", title: "Orders", purpose: "Ship", repositoryIds: [repo.id] }, main);
  const deliverable = await planning({ type: "createDeliverable", projectId: project.id, title: "Feature", acceptanceCriteria: ["Works"], requiredTests: ["unit"] }, main);
  const doc = await planning({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: "Plan", kind: "implementation-plan", content: "Do it" }, main);

  // Approval is the person's: the window's origin, not an agent's call.
  const { serverSession } = await snapshot();
  const approved = await fetch(`${base}/api/inbox/planning/command`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ serverSession, command: { type: "approveDocument", documentId: doc.id, expectedRevisionId: doc.latestRevisionId, person: "Person" } }),
  });
  expect(approved.status).toBe(200);
  const approval = ((await approved.json()) as { result: { id: string } }).result;

  const run = (cwd: string) => planning({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], sessionId: "ses_a" }, cwd);
  const [onMain, onFeature] = [await run(main), await run(join(feature, "src"))];
  expect(onMain.checkoutId).toBe(mainCheckout.id);
  expect(onFeature.checkoutId).toBe(featureCheckout.id);

  // An agent cannot name another checkout through the command itself.
  const forged = await planning({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], sessionId: "ses_a", checkoutPath: main }, feature);
  expect(forged.checkoutId).toBe(featureCheckout.id);

  const { state } = await snapshot();
  expect(state.checkouts.map((checkout) => checkout.path)).toEqual([main, feature]);
});
