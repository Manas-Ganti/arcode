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
import { LLM } from "../src/llm.js";
import { MarkdownStream, renderMarkdown } from "../src/markdown.js";
import { runCommand } from "../src/tools/shell.js";
import { isModelHotkey, pickerStep } from "../src/picker.js";
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
  if (j.stream) return streamSSE(res, msg);
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...msg }, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;

const work = await mkdtemp(join(tmpdir(), "arcode-work-"));
const data = await mkdtemp(join(tmpdir(), "arcode-data-"));
const cfg = loadConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "mock-glm", summaryModel: "mock-glm", workdir: work, dataDir: data, autoApprove: true, contextBudget: 400, extraBody: { reasoning_effort: "low" } });
const session = await Session.create(data, work, cfg.model, "create hello.txt");
const events: string[] = [];
let streamedText = "";
const final = await runAgent("create hello.txt", {
  config: cfg, session, approve: async () => true,
  onEvent: (e) => { events.push(e.type); if (e.type === "llm_start") streamedText = ""; if (e.type === "delta" && e.kind === "content") streamedText += e.text; },
});
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

checks.push(["agent turns streamed, compaction not", requests.filter((r) => r.tools).every((r) => r.stream) && requests.filter((r) => r.messages && !r.tools).every((r) => !r.stream)]);
checks.push(["streamed deltas reassemble the final answer", streamedText === final && events.includes("llm_start")]);
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

// Stalls: the first request of each kind hangs (mid-stream, or before any response); the retry answers.
let stallHits = 0;
const stallServer = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const j = JSON.parse(body);
  stallHits++;
  if (stallHits === 1) { res.setHeader("Content-Type", "text/event-stream"); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`); return; }
  if (stallHits === 3) return; // never respond
  if (j.stream) return streamSSE(res, { content: "recovered" });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }] }));
});
await new Promise<void>((r) => stallServer.listen(0, r));
const stallLLM = new LLM(`http://127.0.0.1:${(stallServer.address() as any).port}/v1`, "x", {}, 300);
const retries: string[] = [];
const streamed = await stallLLM.chat({ model: "m", messages: [{ role: "user", content: "hi" }], onDelta: () => {}, onRetry: (r) => retries.push(r.reason) }).catch((e) => e);
const buffered = await stallLLM.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
stallServer.closeAllConnections();
stallServer.close();
checks.push(["stalled stream is aborted and retried", streamed?.message?.content === "recovered" && streamed.attempts === 2]);
checks.push(["retry reason reported as stalled", retries[0] === "stalled"]);
checks.push(["stalled buffered request is aborted and retried", buffered?.message?.content === "recovered" && stallHits === 4]);

// Markdown → ANSI (ESC[1m bold, ESC[3m italic, ESC[36m code).
const B = "\x1b[1m", I = "\x1b[3m", C = "\x1b[36m";
const md = renderMarkdown("Use **bold** and *it* with `**raw**`\n2 * 3 * 4 and snake_case_name\n```\n**not bold** in fence\n```\n# Title\n- item");
const mdLines = md.split("\n");
checks.push(["markdown: bold, italic, code", mdLines[0].includes(`${B}bold`) && mdLines[0].includes(`${I}it`) && mdLines[0].includes(`${C}**raw**`)]);
checks.push(["markdown: math and snake_case untouched", mdLines[1] === "2 * 3 * 4 and snake_case_name"]);
checks.push(["markdown: fenced code left verbatim", mdLines[3].includes("**not bold**") && !mdLines[3].includes(B)]);
checks.push(["markdown: heading and bullet", mdLines[5].includes(`${B}`) && !mdLines[5].includes("#") && mdLines[6].startsWith("• ")]);
const ms = new MarkdownStream(80);
const streamedMd = ms.push("a **b") + ms.push("old** c\nnext *x*") + ms.flush();
checks.push(["markdown: span split across stream chunks is styled on redraw", streamedMd.includes(`${B}bold`) && streamedMd.includes(`${I}x`)]);

// Credentials must not reach commands the model runs (they'd land in trajectories via `env`).
process.env.ARC_API_KEY = "sk-secret-test-value";
process.env.ARCODE_TEST_VISIBLE = "kept";
const envOut = (await runCommand("env", tmpdir(), 10_000)).out;
checks.push(["API keys withheld from agent commands", !envOut.includes("sk-secret-test-value") && envOut.includes("ARCODE_TEST_VISIBLE=kept")]);

// "Always allow" chosen at the first prompt must cover the rest of the *current* task.
let alwaysN = 0;
const alwaysServer = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const step = alwaysN++;
  const msg = step === 0 ? { content: null, tool_calls: [call("write_file", { path: "a.txt", content: "a" })] }
    : step === 1 ? { content: null, tool_calls: [call("write_file", { path: "b.txt", content: "b" }), call("bash", { command: "true" })] }
    : { content: "done" };
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...msg }, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }] }));
});
await new Promise<void>((r) => alwaysServer.listen(0, r));
const alwaysWork = await mkdtemp(join(tmpdir(), "arcode-always-"));
const alwaysCfg = loadConfig({ baseUrl: `http://127.0.0.1:${(alwaysServer.address() as any).port}/v1`, apiKey: "x", model: "mock", workdir: alwaysWork, dataDir: data, autoApprove: false, stream: false });
let prompts = 0;
const alwaysApprove = async () => { prompts++; alwaysCfg.autoApprove = true; return true; }; // the user pressed "a"
await runAgent("write two files", { config: alwaysCfg, session: await Session.create(data, alwaysWork, "mock", "t"), approve: alwaysApprove });
alwaysServer.close();
checks.push(["'a' (always allow) applies to the rest of the running task", prompts === 1 && (await readFile(join(alwaysWork, "b.txt"), "utf8")) === "b"]);

// Arrow-key picker and the Option+M hotkey.
const step = (i: number, str: string | undefined, key: object | undefined) => JSON.stringify(pickerStep(i, 4, str, key as any));
checks.push(["picker: arrows move and wrap", step(0, undefined, { name: "down" }) === '{"index":1}' && step(0, undefined, { name: "up" }) === '{"index":3}' && step(3, undefined, { name: "down" }) === '{"index":0}']);
checks.push(["picker: Enter selects, digit jumps", step(2, "\r", { name: "return" }) === '{"done":2}' && step(0, "3", { name: "3" }) === '{"done":2}' && step(0, "9", { name: "9" }) === '{"index":0}']);
checks.push(["picker: Esc and Ctrl+C cancel", step(1, undefined, { name: "escape" }) === '{"cancel":true}' && step(1, "\u0003", { name: "c", ctrl: true }) === '{"cancel":true}']);
checks.push(["hotkey: Ctrl+O, and Option+M in both terminal modes", !!isModelHotkey("\u000f", { name: "o", ctrl: true }) && isModelHotkey("µ", undefined) && !!isModelHotkey("\u001bm", { name: "m", meta: true })]);
checks.push(["hotkey: plain M, Shift+M and o are just text", !isModelHotkey("m", { name: "m" }) && !isModelHotkey("M", { name: "m", shift: true } as any) && !isModelHotkey("o", { name: "o" })]);

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

/** Send a scripted message as OpenAI-style SSE: text in small pieces, tool-call arguments split across chunks. */
function streamSSE(res: import("node:http").ServerResponse, msg: any) {
  res.setHeader("Content-Type", "text/event-stream");
  const send = (delta: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`);
  const reasoning = msg.reasoning ?? msg.reasoning_content;
  if (reasoning) for (const part of chunks(reasoning)) send({ reasoning: part });
  if (msg.content) for (const part of chunks(msg.content)) send({ content: part });
  (msg.tool_calls ?? []).forEach((tc: any, index: number) => {
    const [a, b] = [tc.function.arguments.slice(0, 7), tc.function.arguments.slice(7)];
    send({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: a } }] });
    send({ tool_calls: [{ index, function: { arguments: b } }] });
  });
  send({}, { finish_reason: msg.tool_calls ? "tool_calls" : "stop" });
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function chunks(s: string, n = 5): string[] {
  const out: string[] = [];
  for (let k = 0; k < s.length; k += n) out.push(s.slice(k, k + n));
  return out;
}
