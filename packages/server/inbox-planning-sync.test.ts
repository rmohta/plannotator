/**
 * `POST /api/inbox/control/planning-sync`: the connection route a planning
 * CLI in its own process calls after writing the Plan Library store
 * directly, so a pending deviation becomes an "Approval required" Inbox
 * message without waiting for the next Inbox start. Proved against a real
 * running Inbox: the token guards, and the delivery itself (the route, not
 * the seeding, delivers the message — the store is seeded only once the
 * Inbox is already up, after its startup sync has run on an empty store).
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanningStore } from "@plannotator/shared/planning/store";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";

const route = (server: InboxServer, token: string | null, method = "POST", origin?: string) =>
  fetch(`http://127.0.0.1:${server.port}/api/inbox/control/planning-sync`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
  });

/** The minimum chain a deviation needs (the inbox-planning-delivery precedent): plan → deliverable → approved plan → run → deviation. */
async function seedDeviation(dataDir: string): Promise<{ threadName: string; subject: string }> {
  const planning = new PlanningStore({ dataDir });
  const project = await planning.execute({ type: "createProject", title: "Project", purpose: "Feature", repositoryIds: [] });
  const deliverable = await planning.execute({ type: "createDeliverable", projectId: project.id, title: "Outcome", acceptanceCriteria: ["Works"], requiredTests: ["unit"] });
  const document = await planning.execute({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: "Plan", kind: "implementation-plan", content: "# Plan" });
  const approval = await planning.execute({ type: "approveDocument", documentId: document.id, expectedRevisionId: document.latestRevisionId, person: "Reviewer" });
  const run = await planning.execute({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], agentName: "agent-session" });
  const deviation = await planning.execute({ type: "requestDeviation", agentName: run.agentName, repositoryIds: [], relevantText: "24 hours", proposedChange: "48 hours", reason: "Retry window", impact: "Retention" });
  return { threadName: `Deviation ${deviation.id}`, subject: `Deviation: ${document.title}` };
}

const rowsNamed = (dataDir: string, threadName: string) =>
  InboxStore.open(dataDir).listRows().filter(row => row.thread_name === threadName);

test("planning-sync is a connection route: the registry token, no browser, POST only", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planning-sync-guards-"));
  let server: InboxServer | null = null;
  try {
    server = await startInboxServer({ dataDir });
    expect((await route(server, null)).status).toBe(401);
    expect((await route(server, "wrong-token")).status).toBe(401);
    expect((await route(server, server.token, "POST", "http://localhost:5173")).status).toBe(403);
    expect((await route(server, server.token, "GET")).status).toBe(405);
  } finally {
    server?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("planning-sync delivers a pending deviation exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "planning-sync-deliver-"));
  let server: InboxServer | null = null;
  try {
    server = await startInboxServer({ dataDir });
    const { threadName, subject } = await seedDeviation(dataDir);
    // The startup sync ran on an empty store, and the seeding writes only the
    // planning store: the deviation is undelivered until the route runs.
    expect(rowsNamed(dataDir, threadName)).toHaveLength(0);

    const first = await route(server, server.token);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const delivered = rowsNamed(dataDir, threadName);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subject).toBe(subject);
    expect(delivered[0]!.waiting_on_person).toBe(true);

    const second = await route(server, server.token);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(rowsNamed(dataDir, threadName)).toHaveLength(1);
  } finally {
    server?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
