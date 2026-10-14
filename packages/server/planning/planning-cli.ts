/**
 * `plannotator planning <list|show|context|export|request>` — the permanent Plan
 * Library from the command line: the same store, the same discovery shape and
 * the same command objects the Inbox's `read_planning` / `request_planning`
 * MCP tools expose, callable without a running Inbox. Person decisions
 * (approvals, deviation decisions, sign-offs, baseline acceptance, merge
 * evidence) stay in the Plans window — the CLI refuses them; that is the v1
 * security boundary, matching the MCP tool's agent-command guard.
 *
 * Kept free of process.exit / console so it is unit-testable; the CLI entry
 * prints `stdout`/`stderr` and exits with `code`.
 */
import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  DocumentRevision,
  PlanDocument,
  PlanningContext,
  PlanningState,
} from "@plannotator/core/planning-types";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { inboxStatus } from "@plannotator/shared/inbox/registry";
import { PlanningStore } from "@plannotator/shared/planning/store";
import { PLANNING_PERSON_COMMANDS, planningCommand } from "../inbox-planning";

const runGit = promisify(execFile);

export interface PlanningCliResult {
  code: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

/** What `runPlanningCli` may inject: stdin for `request -`, a fetch for the delivery poke. */
export interface PlanningCliIo {
  stdin?: () => string;
  fetch?: typeof fetch;
}

export const PLANNING_CLI_USAGE = [
  "Usage:",
  "  plannotator planning list [--kind repositories|checkouts|projects|deliverables|documents|runs|deviations|decisions|baselines] [--offset N] [--limit N] [--json]",
  "  plannotator planning show <id> [--revision <revisionId>] [--json]",
  "  plannotator planning context <runId> [--offset N] [--limit N] [--json]",
  "  plannotator planning export revision <revisionId> --out <file> [--json]",
  "  plannotator planning export run <runId> --out <directory> [--json]",
  "  plannotator planning request <command.json | -> [--json]",
  "",
  "Read and write the Plan Library (Projects, Deliverables, plans, implementation runs) from the terminal.",
  "Person decisions — approvals, deviation decisions, sign-offs, baselines, merge evidence — stay in the",
  "Plans window (plannotator inbox, then Plans).",
  "",
  "Options:",
  "  --kind <kind>      (list) One collection: repositories, checkouts, projects, deliverables,",
  "                     documents, runs, deviations, decisions, baselines. Default: every collection.",
  "  --offset N         Skip the first N records (default 0)",
  "  --limit N          Read at most N records, 1-100 (default 20)",
  "  --revision <id>    (show) This revision of the document instead of the latest",
  "  --out <path>       (export) New file or directory; existing outputs are refused",
  "  --json             Print machine-readable JSON instead of text",
  "",
  "Exports write complete pinned content to local files, without paging or text limits.",
  "Run exports include manifest.json and one Markdown file per pinned revision.",
  "Read the manifest and every revision file before implementing; exports are snapshots.",
  "",
  "`request` takes the same command objects as the Inbox's request_planning tool — ONE bare object,",
  "not wrapped in {\"command\": ...}. `-` reads it from stdin:",
  "",
  "  plannotator planning request - <<'JSON'",
  '  {"type":"createProject","title":"Retry queued jobs","purpose":"Jobs survive a broker restart","repositoryIds":[]}',
  "  JSON",
  "",
  "Running `request` from a git worktree binds that worktree (the store records it as the run's",
  "checkout); a checkoutPath in the command itself is ignored.",
  "",
  "Exit codes: 0 done · 1 not found / validation / conflict · 2 usage",
].join("\n");

const LIST_KINDS = ["repositories", "checkouts", "projects", "deliverables", "documents", "runs", "deviations", "decisions", "baselines"] as const;
type ListKind = (typeof LIST_KINDS)[number];

function usageError(message?: string): PlanningCliResult {
  return { code: 2, stderr: message ? `${message}\n\n${PLANNING_CLI_USAGE}\n` : `${PLANNING_CLI_USAGE}\n` };
}

function takeOption(args: string[], name: string): { value?: string; rest: string[] } | { error: string } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args };
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return { error: `${name} requires a value` };
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

function takeFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const i = args.indexOf(name);
  if (i < 0) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, i), ...args.slice(i + 1)] };
}

/** `--offset` / `--limit`: whole numbers within the MCP read_planning bounds; absent means the default. */
function parseCount(value: string | undefined, name: string, min: number, max: number | undefined, fallback: number): { value: number } | { error: string } {
  if (value === undefined) return { value: fallback };
  if (!/^\d+$/.test(value)) return { error: `${name} must be a whole number${max ? ` from ${min} to ${max}` : ` of at least ${min}`}` };
  const n = Number(value);
  if (n < min || (max !== undefined && n > max)) return { error: `${name} must be ${max ? `from ${min} to ${max}` : `at least ${min}`}` };
  return { value: n };
}

const tail8 = (id: string | undefined): string => (id ? id.slice(-8) : "-");

/** The collections `list` pages over, in display order — exactly the MCP discovery set. */
const PAGED_KINDS = ["repositories", "checkouts", "projects", "deliverables", "documents", "runs", "deviations", "decisions"] as const;

/**
 * The MCP `read_planning` discovery shape: each collection sliced the same
 * way, the full baselines record, and `nextOffset` when any collection has
 * more. `list --json` (no --kind) prints this verbatim.
 */
function discovery(state: PlanningState, offset: number, limit: number) {
  return {
    repositories: state.repositories.slice(offset, offset + limit),
    checkouts: state.checkouts.slice(offset, offset + limit),
    projects: state.projects.slice(offset, offset + limit),
    deliverables: state.deliverables.slice(offset, offset + limit),
    documents: state.documents.slice(offset, offset + limit),
    runs: state.runs.slice(offset, offset + limit),
    deviations: state.deviations.slice(offset, offset + limit),
    decisions: state.decisions.slice(offset, offset + limit),
    baselines: state.baselines,
    nextOffset:
      offset + limit < Math.max(...PAGED_KINDS.map((kind) => (state[kind] as unknown[]).length))
        ? offset + limit
        : undefined,
  };
}

function listLine(kind: ListKind, record: unknown): string {
  const r = record as Record<string, unknown>;
  switch (kind) {
    case "documents": {
      const doc = record as PlanDocument;
      const rev = doc.latestRevisionId ? ` rev ${tail8(doc.latestRevisionId)}` : "";
      return `${doc.id}  ${doc.title} [${doc.kind}]${rev}`;
    }
    case "checkouts":
      return `${r.id}  ${r.path} repository=${r.repositoryId}`;
    case "runs":
      return `${r.id}  state=${r.state} deliverable=${tail8(r.deliverableId as string)}`;
    case "deviations":
      return `${r.id}  state=${r.state}`;
    case "decisions":
      return `${r.id}  ${r.action}`;
    case "baselines":
      return `${r.service}  ${r.revision}`;
    default:
      return `${r.id}  ${r.title}`;
  }
}

const SECTION_TITLES: Record<ListKind, string> = {
  repositories: "Repositories",
  checkouts: "Checkouts",
  projects: "Projects",
  deliverables: "Deliverables",
  documents: "Documents",
  runs: "Runs",
  deviations: "Deviations",
  decisions: "Decisions",
  baselines: "Baselines",
};

function listSection(kind: ListKind, rows: unknown[]): string[] {
  const lines = [`${SECTION_TITLES[kind]} (${rows.length})`];
  for (const record of rows) lines.push(listLine(kind, record));
  return lines;
}

async function runPlanningList(argv: string[]): Promise<PlanningCliResult> {
  const kindOpt = takeOption(argv, "--kind");
  if ("error" in kindOpt) return usageError(kindOpt.error);
  const offsetOpt = takeOption(kindOpt.rest, "--offset");
  if ("error" in offsetOpt) return usageError(offsetOpt.error);
  const limitOpt = takeOption(offsetOpt.rest, "--limit");
  if ("error" in limitOpt) return usageError(limitOpt.error);
  const jsonFlag = takeFlag(limitOpt.rest, "--json");
  if (jsonFlag.rest.length > 0) return usageError(`Unknown argument: ${jsonFlag.rest[0]}`);

  const offset = parseCount(offsetOpt.value, "--offset", 0, undefined, 0);
  if ("error" in offset) return usageError(offset.error);
  const limit = parseCount(limitOpt.value, "--limit", 1, 100, 20);
  if ("error" in limit) return usageError(limit.error);

  const kind = kindOpt.value as ListKind | undefined;
  if (kind !== undefined && !LIST_KINDS.includes(kind)) {
    return usageError(`--kind must be one of: ${LIST_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
  }

  const state = await new PlanningStore({ dataDir: getPlannotatorDataDir() }).read();
  if (kind === undefined) {
    const shape = discovery(state, offset.value, limit.value);
    if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify(shape)}\n` };
    const lines: string[] = [];
    for (const k of PAGED_KINDS) {
      lines.push(...listSection(k, shape[k] as unknown[]));
    }
    const baselineRows = Object.entries(state.baselines).map(([service, revision]) => ({ service, revision }));
    lines.push(...listSection("baselines", baselineRows));
    if (shape.nextOffset !== undefined) lines.push(`nextOffset: ${shape.nextOffset} (more)`);
    return { code: 0, stdout: `${lines.join("\n")}\n` };
  }

  // One collection: the same paging, the same nextOffset rule.
  if (kind === "baselines") {
    const baselines = state.baselines;
    if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify({ baselines })}\n` };
    const rows = Object.entries(baselines).map(([service, revision]) => ({ service, revision }));
    return { code: 0, stdout: `${listSection("baselines", rows).join("\n")}\n` };
  }
  const rows = (state[kind] as unknown[]).slice(offset.value, offset.value + limit.value);
  const nextOffset = offset.value + limit.value < (state[kind] as unknown[]).length ? offset.value + limit.value : undefined;
  if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify({ [kind]: rows, ...(nextOffset !== undefined && { nextOffset }) })}\n` };
  const lines = listSection(kind, rows);
  if (nextOffset !== undefined) lines.push(`nextOffset: ${nextOffset} (more)`);
  return { code: 0, stdout: `${lines.join("\n")}\n` };
}

/** Every collection in the state, so `show` can address any record (a scripting affordance beyond the MCP surface). */
const RECORD_COLLECTIONS = [
  "repositories",
  "checkouts",
  "projects",
  "deliverables",
  "documents",
  "revisions",
  "approvals",
  "runs",
  "deviations",
  "decisions",
  "alignments",
  "merges",
  "baselineUpdates",
] as const;

function findRecord(state: PlanningState, id: string): { kind: string; record: unknown } | undefined {
  for (const kind of RECORD_COLLECTIONS) {
    const record = (state[kind] as { id?: string }[]).find((item) => item.id === id);
    if (record) return { kind, record };
  }
  return undefined;
}

function documentOutput(document: PlanDocument, revisions: DocumentRevision[], revision: DocumentRevision): string {
  const meta = [
    `id: ${document.id}`,
    `title: ${document.title}`,
    `kind: ${document.kind}`,
    `projectId: ${document.projectId}`,
    ...(document.deliverableId ? [`deliverableId: ${document.deliverableId}`] : []),
    ...(document.serviceId ? [`serviceId: ${document.serviceId}`] : []),
    `linkedDocumentIds: ${document.linkedDocumentIds.join(", ")}`,
    "",
    `Revisions (${revisions.length})`,
    ...revisions.map((r) => `${r.id}  ${r.createdAt}`),
    "",
    revision.content,
  ];
  return `${meta.join("\n")}\n`;
}

async function runPlanningShow(argv: string[]): Promise<PlanningCliResult> {
  const revisionOpt = takeOption(argv, "--revision");
  if ("error" in revisionOpt) return usageError(revisionOpt.error);
  const jsonFlag = takeFlag(revisionOpt.rest, "--json");
  const rest = jsonFlag.rest;
  if (rest.length === 0 || rest[0].startsWith("--")) return usageError("show needs a record id.");
  if (rest.length > 1) return usageError(`Unknown argument: ${rest[1]}`);

  const state = await new PlanningStore({ dataDir: getPlannotatorDataDir() }).read();
  const id = rest[0];
  const found = findRecord(state, id);
  if (!found) return { code: 1, stderr: `not_found: no planning record ${id}\n` };
  if (revisionOpt.value && found.kind !== "documents") return usageError("--revision applies to documents.");
  const record = found.record as Record<string, unknown>;

  if (found.kind === "documents") {
    const document = record as unknown as PlanDocument;
    const revisions = state.revisions.filter((r) => r.documentId === document.id); // oldest first, newest last
    if (jsonFlag.present && !revisionOpt.value) return { code: 0, stdout: `${JSON.stringify({ document, revisions })}\n` };
    const revision = revisionOpt.value
      ? revisions.find((r) => r.id === revisionOpt.value)
      : revisions.find((r) => r.id === document.latestRevisionId) ?? revisions.at(-1);
    if (!revision) return { code: 1, stderr: `not_found: no revision ${revisionOpt.value} of document ${document.id}\n` };
    if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify({ revision })}\n` };
    return { code: 0, stdout: documentOutput(document, revisions, revision) };
  }

  if (found.kind === "revisions") {
    const revision = record as unknown as DocumentRevision;
    if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify({ revision })}\n` };
    return { code: 0, stdout: `${revision.content}\n` };
  }

  if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify(record)}\n` };
  const lines = Object.entries(record).map(([key, value]) =>
    `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return { code: 0, stdout: `${lines.join("\n")}\n` };
}

function contextOutput(context: PlanningContext): string {
  const lines = [
    `Project ${context.project.title} (${context.project.id})`,
    `Deliverable ${context.deliverable.title} (${context.deliverable.id})`,
    `Run ${context.run.id} state=${context.run.state} checkoutId=${context.run.checkoutId ?? "-"}`,
    "",
  ];
  for (const entry of context.documents) {
    const truncated = entry.truncated ? ", truncated" : "";
    lines.push(`## ${entry.document.title} (${entry.document.kind}, revision ${entry.revision.id}${truncated})`);
    lines.push(entry.revision.content);
    lines.push("");
  }
  if (context.nextOffset !== undefined) lines.push(`nextOffset: ${context.nextOffset} (more)`);
  return `${lines.join("\n")}\n`;
}

async function runPlanningContext(argv: string[]): Promise<PlanningCliResult> {
  const offsetOpt = takeOption(argv, "--offset");
  if ("error" in offsetOpt) return usageError(offsetOpt.error);
  const limitOpt = takeOption(offsetOpt.rest, "--limit");
  if ("error" in limitOpt) return usageError(limitOpt.error);
  const jsonFlag = takeFlag(limitOpt.rest, "--json");
  const rest = jsonFlag.rest;
  if (rest.length === 0 || rest[0].startsWith("--")) return usageError("context needs a run id.");
  if (rest.length > 1) return usageError(`Unknown argument: ${rest[1]}`);
  const offset = parseCount(offsetOpt.value, "--offset", 0, undefined, 0);
  if ("error" in offset) return usageError(offset.error);
  const limit = parseCount(limitOpt.value, "--limit", 1, 100, 20);
  if ("error" in limit) return usageError(limit.error);

  try {
    const context = await new PlanningStore({ dataDir: getPlannotatorDataDir() }).context(rest[0], {
      offset: offset.value,
      limit: limit.value,
    });
    if (jsonFlag.present) return { code: 0, stdout: `${JSON.stringify(context)}\n` };
    return { code: 0, stdout: contextOutput(context) };
  } catch (error) {
    return { code: 1, stderr: planningErrorMessage(error) };
  }
}


/** Export from one immutable store snapshot, without the context endpoint's paging/content budget. */
async function runPlanningExport(argv: string[], cwd: string): Promise<PlanningCliResult> {
  const outOpt = takeOption(argv, "--out");
  if ("error" in outOpt) return usageError(outOpt.error);
  const jsonFlag = takeFlag(outOpt.rest, "--json");
  const [kind, id, ...extra] = jsonFlag.rest;
  if ((kind !== "revision" && kind !== "run") || !id || id.startsWith("--") || extra.length || !outOpt.value) {
    return usageError("export needs revision <id> or run <id>, and --out <path>.");
  }
  const output = resolve(cwd, outOpt.value);
  let created = false;
  try {
    const state = await new PlanningStore({ dataDir: getPlannotatorDataDir() }).read();
    const record = <T extends { id: string }>(rows: T[], key: string): T => {
      const found = rows.find(row => row.id === key);
      if (!found) throw Object.assign(new Error(`Unknown record: ${key}`), { code: "not_found" });
      return found;
    };
    const revisionInfo = (revision: DocumentRevision, file: string) => {
      const { content, ...metadata } = revision;
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (contentHash !== revision.contentHash) throw Object.assign(new Error(`Revision hash mismatch: ${revision.id}`), { code: "integrity_error" });
      return { ...metadata, file, bytes: Buffer.byteLength(content, "utf8") };
    };
    let summary: Record<string, unknown>;
    if (kind === "revision") {
      const revision = record(state.revisions, id);
      const info = revisionInfo(revision, output);
      const handle = await open(output, "wx", 0o600);
      created = true;
      try { await handle.writeFile(revision.content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      summary = { kind, revisionId: id, path: output, contentHash: info.contentHash, bytes: info.bytes };
    } else {
      const run = record(state.runs, id);
      const deliverable = record(state.deliverables, run.deliverableId);
      const project = record(state.projects, deliverable.projectId);
      const revisions = run.revisionIds.map(key => record(state.revisions, key));
      const documents = revisions.map((revision, index) => ({
        document: record(state.documents, revision.documentId),
        revision: revisionInfo(revision, `documents/${String(index + 1).padStart(3, "0")}.md`),
      }));
      const manifest = {
        version: 1, exportedAt: new Date().toISOString(), run, deliverable, project,
        repositories: project.repositoryIds.map(key => record(state.repositories, key)),
        checkout: run.checkoutId ? record(state.checkouts, run.checkoutId) : undefined,
        approvals: run.approvalIds.map(key => record(state.approvals, key)),
        decisions: run.decisionIds.map(key => record(state.decisions, key)),
        acceptedDeviations: state.deviations.filter(row => row.runId === run.id && row.state === "approved"),
        deviations: state.deviations.filter(row => row.runId === run.id),
        relatedDeliverables: deliverable.relatedDeliverableIds.map(key => record(state.deliverables, key)),
        documents,
      };
      await mkdir(output, { mode: 0o700 });
      created = true;
      await mkdir(join(output, "documents"), { mode: 0o700 });
      for (let index = 0; index < revisions.length; index++) {
        await writeFile(join(output, documents[index].revision.file), revisions[index].content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      summary = { kind, runId: id, path: output, manifestPath: join(output, "manifest.json"), revisionCount: revisions.length };
    }
    return { code: 0, stdout: jsonFlag.present ? `${JSON.stringify(summary)}\n` :
      kind === "revision" ? `Exported revision ${id} to ${output} (${summary.bytes} bytes, sha256 ${summary.contentHash})\n` :
      `Exported run ${id}: ${summary.manifestPath} (${summary.revisionCount} complete revisions)\n` };
  } catch (error) {
    if (created) await rm(output, { recursive: kind === "run", force: true }).catch(() => {});
    return { code: 1, stderr: planningErrorMessage(error) };
  }
}

function planningErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : "validation_error";
  return `${code}: ${error instanceof Error ? error.message : String(error)}\n`;
}

/** The git worktree root of `cwd`, else its realpath: the checkout this CLI run speaks for. */
async function checkoutRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runGit("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { maxBuffer: 1024 * 1024 });
    const top = stdout.trim();
    if (top) return top;
  } catch {
    // not a repository, or no git: fall through to the folder itself
  }
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** One line about what the command produced (title / state / path as fits the type). */
function resultSummary(record: Record<string, unknown>): string {
  if (typeof record.title === "string" && record.title) return record.title;
  if (typeof record.path === "string") return record.path;
  if (typeof record.state === "string" && typeof record.deliverableId === "string") return `state=${record.state} deliverable=${record.deliverableId}`;
  if (typeof record.state === "string" && typeof record.runId === "string") return `state=${record.state} run=${record.runId}`;
  if (typeof record.serviceId === "string") return `service=${record.serviceId}`;
  return "";
}

/**
 * Ask a RUNNING Inbox to turn pending deviation requests into messages for
 * the person (`syncPlanningDelivery`). The CLI writes the store directly, so
 * without this poke the person would not hear about a deviation until the
 * next Inbox start. A stopped or missing Inbox needs no poke. NEVER changes
 * the exit code.
 */
async function pokePlanningDelivery(dataDir: string, io: PlanningCliIo, notes: string[]): Promise<void> {
  const stderrNote = (text: string) => notes.push(text);
  try {
    const status = await inboxStatus(dataDir, 1500);
    if (status.state === "running") {
      const res = await (io.fetch ?? fetch)(`http://127.0.0.1:${status.entry.port}/api/inbox/control/planning-sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${status.entry.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) stderrNote(`Inbox did not sync planning delivery (HTTP ${status}). The next Inbox start will.`);
    }
  } catch {
    stderrNote("Could not sync planning delivery with the running Inbox. The next Inbox start will.");
  }
}

async function runPlanningRequest(argv: string[], cwd: string, io: PlanningCliIo): Promise<PlanningCliResult> {
  const jsonFlag = takeFlag(argv, "--json");
  const rest = jsonFlag.rest;
  if (rest.length === 0 || rest[0].startsWith("--")) return usageError("request needs a command file (or - for stdin).");
  if (rest.length > 1) return usageError(`Unknown argument: ${rest[1]}`);

  let text: string;
  if (rest[0] === "-") {
    text = io.stdin ? io.stdin() : readFileSync(0, "utf-8");
  } else {
    const file = resolve(cwd, rest[0]);
    if (!existsSync(file)) return usageError(`Command file not found: ${file}`);
    try {
      text = readFileSync(file, "utf-8");
    } catch (e) {
      return usageError(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return usageError(`Command is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return usageError("Command must be one JSON object — the bare command itself, not wrapped in {\"command\": ...}.");
  }

  // The checkout comes from where this CLI runs, never from the command: an
  // agent or script must not name another checkout's path (the same rule the
  // request_planning tool enforces).
  const command = parsed as Record<string, unknown>;
  delete command.checkoutPath;
  command.checkoutPath = await checkoutRoot(cwd);

  try {
    planningCommand(command);
  } catch (e) {
    return { code: 1, stderr: `validation_error: ${e instanceof Error ? e.message : String(e)}\n` };
  }
  if (PLANNING_PERSON_COMMANDS.has(command.type as string)) {
    return {
      code: 1,
      stderr:
        "person_decision_required: Only the person can approve, decide a deviation, sign off, accept a baseline or record merge evidence. Do it in the Plans window (plannotator inbox, then Plans).\n",
    };
  }

  const dataDir = getPlannotatorDataDir();
  let result: unknown;
  try {
    result = await new PlanningStore({ dataDir }).execute(command as never);
  } catch (error) {
    return { code: 1, stderr: planningErrorMessage(error) };
  }

  const notes: string[] = [];
  await pokePlanningDelivery(dataDir, io, notes);

  if (jsonFlag.present) {
    return { code: 0, stdout: `${JSON.stringify({ result })}\n`, ...(notes.length > 0 && { stderr: `${notes.join("\n")}\n` }) };
  }
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.id === "string") lines.push(`${command.type} ${record.id}`);
  else if ("continued" in record) lines.push(`${command.type} continued=${String(record.continued)}`);
  else lines.push(String(command.type));
  const summary = resultSummary(record);
  if (summary) lines.push(summary);
  if (command.type === "requestDeviation") {
    lines.push("Affected work is paused; the person decides in the Plans window (plannotator inbox, then Plans).");
  }
  return { code: 0, stdout: `${lines.join("\n")}\n`, ...(notes.length > 0 && { stderr: `${notes.join("\n")}\n` }) };
}

export async function runPlanningCli(
  argv: string[],
  _env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
  io: PlanningCliIo = {},
): Promise<PlanningCliResult> {
  const [sub, ...rest] = argv;
  if (sub === "list") return runPlanningList(rest);
  if (sub === "show") return runPlanningShow(rest);
  if (sub === "context") return runPlanningContext(rest);
  if (sub === "export") return runPlanningExport(rest, cwd);
  if (sub === "request") return runPlanningRequest(rest, cwd, io);
  return usageError();
}
