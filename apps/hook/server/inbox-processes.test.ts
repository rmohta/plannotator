import { describe, expect, test } from "bun:test";
import { classifyInboxCommand, parseInboxProcesses } from "./inbox-processes";

describe("classifyInboxCommand", () => {
  test("the Inbox server, with or without its flags", () => {
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator inbox")).toBe("server");
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator inbox --no-open")).toBe("server");
    expect(classifyInboxCommand("plannotator inbox --background --tailscale")).toBe("server");
    expect(classifyInboxCommand("/usr/bin/bun run apps/hook/server/index.ts inbox --no-open")).toBe("server");
  });
  test("an agent's stdio shim", () => {
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator inbox mcp")).toBe("mcp");
  });
  test("anything else", () => {
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator inbox --notes codex")).toBeNull();
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator inbox mcp extra")).toBeNull();
    expect(classifyInboxCommand("/Users/a/.local/bin/plannotator review")).toBeNull();
    expect(classifyInboxCommand("vim notes/inbox")).toBeNull();
    expect(classifyInboxCommand("grep plannotator inbox")).toBeNull();
    expect(classifyInboxCommand("")).toBeNull();
  });
});

describe("parseInboxProcesses", () => {
  test("keeps Inbox processes, drops this one and unrelated lines", () => {
    const output = [
      "10322 /Users/a/.local/bin/plannotator inbox --no-open",
      "25242 /Users/a/.local/bin/plannotator inbox mcp",
      "30000 /Users/a/.local/bin/plannotator inbox status",
      "31000 /bin/zsh -c plannotator inbox",
      "  7 /sbin/launchd",
      "",
    ].join("\n");
    expect(parseInboxProcesses(output, 30000)).toEqual([
      { pid: 10322, kind: "server", command: "/Users/a/.local/bin/plannotator inbox --no-open" },
      { pid: 25242, kind: "mcp", command: "/Users/a/.local/bin/plannotator inbox mcp" },
    ]);
  });
});
