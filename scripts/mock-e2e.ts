/**
 * Offline end-to-end test: a scripted fake OpenAI-compatible server drives the
 * real agent loop, tools, session store, and compaction. No API key needed.
 *   npm run test:mock
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { defaultContextBudget, modelSpec, resolveModel } from "../src/models.js";
import { Session } from "../src/session.js";
import { runAgent } from "../src/agent.js";

let n = 0;
const call = (name: string, args: object) => ({ id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const script: any[] = [
  { content: null, reasoning_content: "I should plan first.", tool_calls: [call("todo_write", { todos: [{ content: "create hello.txt", status: "in_progress" }, { content: "verify", status: "pending" }] })] },
  { content: null, tool_calls: [call("write_file", { path: "hello.txt", content: "hello arcode\n" }), call("list_dir", {})] },
  // Text-only tool call, exercising the fallback parser.
  { content: 'Checking.\n<tool_call>{"name": "bash", "arguments": {"command": "cat hello.txt"}}</tool_call>' },
  // vLLM-style `reasoning` field (what VT ARC returns) must be normalized too.
  { content: null, reasoning: "Read before editing.", tool_calls: [call("read_file", { path: "hello.txt" })] },
  { content: null, tool_calls: [call("edit_file", { path: "hello.txt", old_string: "hello", new_string: "hi" })] },
  { content: null, tool_calls: [call("note", { text: "hello.txt is the target file" })] },
  { content: "Created hello.txt and verified it with cat." },
];
let i = 0;
const requests: any[] = [];

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const j = body ? JSON.parse(body) : {};
  requests.push(j);
  res.setHeader("Content-Type", "application/json");
  if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock-glm" }] }));
  // Compaction requests have no tools attached.
  if (!j.tools) return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "SUMMARY: created hello.txt" }, finish_reason: "stop" }] }));
  const msg = script[i++] ?? { content: "done" };
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...msg }, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;

const work = await mkdtemp(join(tmpdir(), "arcode-work-"));
const data = await mkdtemp(join(tmpdir(), "arcode-data-"));
const cfg = loadConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "mock-glm", summaryModel: "mock-glm", workdir: work, dataDir: data, autoApprove: true, contextBudget: 400, extraBody: { reasoning_effort: "low" } });
const session = await Session.create(data, work, cfg.model, "create hello.txt");
const events: string[] = [];
const final = await runAgent("create hello.txt", { config: cfg, session, approve: async () => true, onEvent: (e) => events.push(e.type) });
server.close();

const checks: [string, boolean][] = [];
const file = await readFile(join(work, "hello.txt"), "utf8").catch(() => "");
const traj = (await readFile(join(session.dir, "trajectory.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const toolEvents = traj.filter((e) => e.type === "tool");
checks.push(["final answer returned", final.includes("verified")]);
checks.push(["file written then edited", file === "hi arcode\n"]);
checks.push(["text tool-call fallback ran bash", toolEvents.some((e) => e.name === "bash" && e.output.includes("hello arcode"))]);
checks.push(["all tool calls succeeded", toolEvents.every((e) => e.ok)]);
checks.push(["reasoning logged in trajectory", traj.some((e) => e.message?.reasoning_content)]);
checks.push(["`reasoning` field normalized and logged", traj.some((e) => e.message?.reasoning_content === "Read before editing.")]);
checks.push(["reasoning NOT resent to API", requests.every((r) => !/"reasoning(_content)?"/.test(JSON.stringify(r.messages ?? [])))]);
checks.push(["compaction triggered", session.meta.compactions > 0 && events.includes("compaction")]);
checks.push(["todos persisted", (await readFile(join(session.dir, "todos.json"), "utf8")).includes("hello.txt")]);
checks.push(["notes persisted", (await readFile(join(session.dir, "notes.md"), "utf8")).includes("target file")]);
checks.push(["tool results stay paired after compaction", pairedOk(session.messages)]);
checks.push(["session resumable", (await Session.load(data, session.meta.id)).messages.length === session.messages.length]);
checks.push(["status done", session.meta.status === "done"]);

checks.push(["extra body sent on every request (incl. compaction)", requests.filter((r) => r.messages).every((r) => r.reasoning_effort === "low")]);

// Model registry: ARC variant ids share their base entry; unknown ids fall back.
checks.push(["model registry matches variants", modelSpec("DeepSeek-V4.1-Flash-thinking-max").contextWindow === 512_000 && modelSpec("GLM-5.3-thinking-high").known]);
const listed = ["GLM-5.3", "gpt-oss-120b", "DeepSeek-V4.1-Flash"];
checks.push(["model picker resolves number or id, rejects typos", resolveModel("2", listed) === "gpt-oss-120b" && resolveModel("deepseek-v4.1-flash", listed) === "DeepSeek-V4.1-Flash" && !resolveModel("gpt-oss-12", listed) && !resolveModel("4", listed)]);
checks.push(["unknown model falls back", !modelSpec("mock-glm").known && defaultContextBudget("mock-glm") === 96_000]);

// Key loading: ~/.arcode/.env fills gaps, real env wins, VTARC_API_KEY accepted.
const home = await mkdtemp(join(tmpdir(), "arcode-home-"));
await writeFile(join(home, ".env"), "VTARC_API_KEY=from-file\nARCODE_MODEL=from-file\n");
delete process.env.ARC_API_KEY;
delete process.env.VTARC_API_KEY;
Object.assign(process.env, { ARCODE_HOME: home, ARCODE_MODEL: "from-env" });
loadEnvFile();
const envCfg = loadConfig();
checks.push(["VTARC_API_KEY loaded from ARCODE_HOME/.env", envCfg.apiKey === "from-file"]);
checks.push(["real env var beats .env", envCfg.model === "from-env"]);

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

function pairedOk(msgs: any[]): boolean {
  const called = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) called.add(c.id);
    if (m.role === "tool" && !called.has(m.tool_call_id)) return false;
  }
  return true;
}
