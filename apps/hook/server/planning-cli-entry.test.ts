/**
 * `plannotator planning ...` through the real CLI entrypoint, run as a child
 * process (claude-mod-plan.test.ts / the guide-entry test in cli.test.ts
 * pattern): guards the argv hand-off in apps/hook/server/index.ts — the
 * entrypoint strips `--json` from the whole argv before dispatching, so the
 * planning branch must re-read its tokens from rawArgs the way the guide
 * branch does, and `planning list --json` must still print JSON.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlanningStore } from "@plannotator/shared/planning/store";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML at module load; API-only tests need just a stub.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * One `plannotator <argv>` child run under a scratch data dir. The Plan
 * Library store lives under PLANNOTATOR_DATA_DIR, so every run gets a temp
 * one and never reads or writes the real ~/.plannotator.
 */
async function runCli(argv: string[], options: { dataDir: string; stdin?: string }): Promise<CliRun> {
  // "bun" from PATH, not process.execPath: the guide-entry and unknown-
  // subcommand tests in this repo do the same (process.execPath can point at
  // a phantom bun.exe in some environments).
  const proc = Bun.spawn(["bun", "run", entry, ...argv], {
    cwd: options.dataDir,
    env: { ...process.env, PLANNOTATOR_DATA_DIR: options.dataDir },
    ...(options.stdin !== undefined ? { stdin: new TextEncoder().encode(options.stdin) } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  // The planning branch always exits by itself; the kill is only a hang guard
  // for this test's own child.
  const timeout = setTimeout(() => proc.kill(), 25_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function scratchDataDir(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  return dataDir;
}

describe("planning CLI through the entrypoint", () => {
  test("planning --help prints usage without launching anything", async () => {
    const run = await runCli(["planning", "--help"], { dataDir: scratchDataDir("plannotator-planning-help-") });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage:");
    expect(run.stdout).toContain("planning request");
  }, 30_000);

  test("nested deviation help reaches the planning CLI and preserves JSON output", async () => {
    for (const args of [["planning", "request", "requestDeviation", "--help", "--json"], ["planning", "help", "consumeContinuation", "--json"]]) {
      const run = await runCli(args, { dataDir: scratchDataDir("plannotator-planning-command-help-") });
      expect(run.code, run.stderr).toBe(0);
      const help = JSON.parse(run.stdout);
      expect(help.example.type).toBe(args.includes("requestDeviation") ? "requestDeviation" : "consumeContinuation");
      expect(help.requiredFields).toContain("agentName");
      expect(help.requiredFields).not.toContain("runId");
      expect(run.stderr).toBe("");
    }
  }, 30_000);

  test("planning list --json on a fresh data dir prints parseable JSON", async () => {
    const run = await runCli(["planning", "list", "--json"], { dataDir: scratchDataDir("plannotator-planning-list-") });
    expect(run.code, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed.projects).toEqual([]);
    expect(parsed.baselines).toEqual({});
  }, 30_000);

  test("a createProject through request - is visible to a later list --kind projects", async () => {
    const dataDir = scratchDataDir("plannotator-planning-write-");
    const command = JSON.stringify({
      type: "createProject",
      title: "Retry queued jobs",
      purpose: "Jobs survive a broker restart",
      repositoryIds: [],
    });
    const write = await runCli(["planning", "request", "-"], { dataDir, stdin: command });
    expect(write.code, write.stderr).toBe(0);

    // A second spawn reads the same store: the write survived the process.
    const list = await runCli(["planning", "list", "--kind", "projects", "--json"], { dataDir });
    expect(list.code, list.stderr).toBe(0);
    const projects = (JSON.parse(list.stdout) as { projects: { title: string }[] }).projects;
    expect(projects).toHaveLength(1);
    expect(projects[0]!.title).toBe("Retry queued jobs");
  }, 30_000);

  test("a person-decision command is refused with person_decision_required", async () => {
    const run = await runCli(["planning", "request", "-"], {
      dataDir: scratchDataDir("plannotator-planning-person-"),
      stdin: JSON.stringify({ type: "approveDocument", documentId: "x", expectedRevisionId: "y", person: "p" }),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("person_decision_required");
  }, 30_000);

  test("exact exports through the entrypoint write files and keep stdout compact", async () => {
    const dataDir = scratchDataDir("plannotator-planning-export-");
    const store = new PlanningStore({ dataDir });
    const project = await store.execute({ type: "createProject", title: "Project", purpose: "Exact context", repositoryIds: [] });
    const deliverable = await store.execute({ type: "createDeliverable", projectId: project.id, title: "Outcome", acceptanceCriteria: ["Works"], requiredTests: ["unit"] });
    const content = "# Exact\r\n" + "雪".repeat(100_001);
    const doc = await store.execute({ type: "createDocument", projectId: project.id, deliverableId: deliverable.id, title: "Plan", kind: "implementation-plan", content });
    const approval = await store.execute({ type: "approveDocument", documentId: doc.id, expectedRevisionId: doc.latestRevisionId, person: "Reviewer" });
    const run = await store.execute({ type: "startRun", deliverableId: deliverable.id, approvalIds: [approval.id], agentName: "export-test" });
    const revisionExport = await runCli(["planning", "export", "revision", String(doc.latestRevisionId), "--out", "exact.md", "--json"], { dataDir });
    expect(revisionExport.code, revisionExport.stderr).toBe(0);
    const revisionResult = JSON.parse(revisionExport.stdout);
    expect(revisionResult.path).toBe(join(dataDir, "exact.md"));
    expect(readFileSync(revisionResult.path, "utf8")).toBe(content);
    expect(revisionExport.stdout.length).toBeLessThan(1000);
    const runExport = await runCli(["planning", "export", "agent", run.agentName, "--out", "context", "--json"], { dataDir });
    expect(runExport.code, runExport.stderr).toBe(0);
    const runResult = JSON.parse(runExport.stdout);
    const manifest = JSON.parse(readFileSync(runResult.manifestPath, "utf8"));
    expect(manifest.run.id).toBe(run.id);
    expect(manifest.approvals[0].id).toBe(approval.id);
    expect(readFileSync(join(runResult.path, manifest.documents[0].revision.file), "utf8")).toBe(content);
    expect(runExport.stdout.length).toBeLessThan(1000);
  }, 30_000);

  test("an unknown planning subcommand exits 2 with usage on stderr", async () => {
    const run = await runCli(["planning", "bogus"], { dataDir: scratchDataDir("plannotator-planning-bogus-") });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Usage");
  }, 30_000);
});
