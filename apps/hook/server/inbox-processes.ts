/**
 * The `plannotator inbox` processes on this computer, read from `ps`, for
 * `plannotator inbox status`. The registry (`inbox/inbox.json`) names one
 * Inbox; this finds the others: a server an older binary left running, or a
 * second one started against another data folder, and the stdio shims that
 * agents run (`plannotator inbox mcp`).
 */

import { spawnSync } from "node:child_process";

export interface InboxProcess {
  pid: number;
  /** `server`: the Inbox itself. `mcp`: an agent's stdio shim (a client of the server, not a second one). */
  kind: "server" | "mcp";
  command: string;
}

const SERVER_FLAGS = new Set(["--background", "--no-open", "--tailscale"]);
const SCRIPT = /\.[cm]?[jt]s$/;
const EXECUTABLE = /(?:^|[\\/])plannotator(?:\.exe)?$|\.[cm]?[jt]s$/;

/**
 * Classify one `ps` command line, or null when it is not an Inbox process.
 * Split on whitespace: a plannotator binary in a folder whose name holds a
 * space is not recognised.
 */
export function classifyInboxCommand(command: string): InboxProcess["kind"] | null {
  const tokens = command.trim().split(/\s+/);
  const at = tokens.indexOf("inbox");
  // The binary is the command itself; a script (`bun run index.ts inbox`) follows an interpreter.
  if (at < 1 || !EXECUTABLE.test(tokens[at - 1]!) || (at > 1 && !SCRIPT.test(tokens[at - 1]!))) return null;
  const rest = tokens.slice(at + 1);
  if (rest[0] === "mcp") return rest.length === 1 ? "mcp" : null;
  return rest.every((token) => SERVER_FLAGS.has(token)) ? "server" : null;
}

/** Parse `ps -o pid= -o command=` output; `self` (this process) is left out. */
export function parseInboxProcesses(output: string, self: number): InboxProcess[] {
  const found: InboxProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === self) continue;
    const kind = classifyInboxCommand(match[2]!);
    if (kind) found.push({ pid, kind, command: match[2]!.trim() });
  }
  return found;
}

/** This user's Inbox processes; null where `ps` cannot answer (Windows). */
export function listInboxProcesses(): InboxProcess[] | null {
  if (process.platform === "win32") return null;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;
  const args = uid ? ["-u", uid, "-o", "pid=", "-o", "command="] : ["-A", "-o", "pid=", "-o", "command="];
  const result = spawnSync("ps", args, { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return parseInboxProcesses(result.stdout, process.pid);
}
