/**
 * Offline test of the MCP client against a fake stdio server (scripts/fixtures/fake-mcp-server.mjs):
 * handshake, paginated tools/list, server→client ping, approval vs read-only, isError, images,
 * crashes, unsupported protocol versions, unsupported HTTP entries, and credential stripping.
 *   npm run test:mock
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenToolResult, mcpToolName, startMcp } from "../src/mcp.js";
import { loadConfig } from "../src/config.js";
import type { ToolContext } from "../src/tools/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");
const home = await mkdtemp(join(tmpdir(), "arcode-mcp-"));
await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: {
  fake: { command: process.execPath, args: [fixture] },
  oldproto: { command: process.execPath, args: [fixture], env: { FAKE_PROTO: "1999-01-01" } },
  missing: { command: "/nonexistent/mcp-server" },
  remote: { url: "https://example.com/mcp" },
  off: { command: "true", disabled: true },
} }));

process.env.ARC_API_KEY = "sk-should-not-leak";
const mcp = await startMcp(home);
const checks: [string, boolean][] = [];
const tool = (n: string) => mcp.tools.find((t) => t.name === `mcp__fake__${n}`)!;
let approvals = 0;
const ctx = (allow: boolean): ToolContext => ({ config: loadConfig(), session: undefined as any, approve: async () => { approvals++; return allow; } });

checks.push(["working server: tools from both pages", mcp.status.includes("fake: 4 tools") && ["echo", "write_note", "crash", "env_has_key"].every((n) => tool(n))]);
checks.push(["unsupported protocol version is refused", mcp.status.some((s) => s.startsWith("oldproto: failed (unsupported protocol version 1999-01-01"))]);
checks.push(["missing command reported, not fatal", mcp.status.some((s) => s.startsWith("missing: failed"))]);
checks.push(["HTTP entries skipped with a reason", mcp.status.includes("remote: skipped (HTTP servers aren't supported yet)")]);
checks.push(["disabled servers not started", !mcp.status.some((s) => s.startsWith("off"))]);

approvals = 0;
const echo = await tool("echo").run({ text: "hi" }, ctx(false));
checks.push(["read-only tool runs without approval", echo === "echo: hi (pong-ok)" && approvals === 0]);
checks.push(["server→client ping answered", echo.includes("pong-ok")]);
checks.push(["mutating tool asks; denial respected", (await tool("write_note").run({ text: "x" }, ctx(false))) === "denied by user" && approvals === 1]);
const note = await tool("write_note").run({ text: "x" }, ctx(true));
checks.push(["content blocks flattened (text + image)", note.startsWith("saved: x\n[image: image/png")]);
checks.push(["isError → error: string", (await tool("write_note").run({ fail: true }, ctx(true))) === "error: disk full"]);
checks.push(["arcode's API key not passed to servers", (await tool("env_has_key").run({}, ctx(true))) === "no"]);
const crashed = await tool("crash").run({}, ctx(true));
const after = await tool("echo").run({ text: "again" }, ctx(true));
checks.push(["crash becomes an error string, never a throw", crashed.startsWith("error: MCP fake.crash failed") && after.startsWith("error: MCP fake.echo failed")]);
mcp.close();

checks.push(["long names fit OpenAI's 64-char limit", mcpToolName("a".repeat(40), "b".repeat(40)).length === 64 && mcpToolName("my server", "do.thing") === "mcp__my_server__do_thing"]);
checks.push(["embedded resource text used", flattenToolResult({ content: [{ type: "resource", resource: { uri: "file:///a", text: "body" } }] }) === "body"]);
checks.push(["no config file → no servers", (await startMcp(await mkdtemp(join(tmpdir(), "arcode-mcp-empty-")))).tools.length === 0]);

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
