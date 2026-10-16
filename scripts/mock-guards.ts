/**
 * Offline tests for the guards (src/guards.ts) and their wiring in the agent loop:
 * output cap / truncation, per-call timeout, deadline notices, loop detection,
 * verify-before-finish, and hiding web_search without a provider.
 *   npm run test:mock
 */
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { Session } from "../src/session.js";
import { runAgent } from "../src/agent.js";
import { Guards } from "../src/guards.js";

const checks: [string, boolean][] = [];
let n = 0;
const call = (name: string, args: object) => ({ id: `g${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const call1 = (name: string, args: object) => ({ call: call(name, args) as any, ok: true });

// ---- Unit: Guards with a fake clock.
let t = 0;
const g = new Guards({ deadlineS: 100, testsAvailable: true, maxOutputTokens: 16384, callTimeoutS: 300 }, () => t);
t = 50_000;
checks.push(["deadline: quiet with half the time left", g.beforeCall() === undefined]);
t = 71_000;
const d1 = g.beforeCall();
checks.push(["deadline: notice at 30% left", d1?.kind === "deadline" && d1.text.includes("Prioritize") && g.beforeCall() === undefined]);
t = 95_000;
checks.push(["deadline: final notice at 10% left", g.beforeCall()?.text.includes("Stop exploring") === true && g.beforeCall() === undefined]);
const skip = new Guards({ deadlineS: 100, testsAvailable: false, maxOutputTokens: 1, callTimeoutS: 1 }, () => t);
t += 99_000;
checks.push(["deadline: jumping past both thresholds sends one final notice", skip.beforeCall()?.text.includes("Stop exploring") === true && skip.beforeCall() === undefined]);
checks.push(["no deadline configured: never warns", new Guards({ testsAvailable: true, maxOutputTokens: 1, callTimeoutS: 1 }).beforeCall() === undefined]);

const lg = new Guards({ testsAvailable: false, maxOutputTokens: 1, callTimeoutS: 1 });
lg.afterTools([call1("list_dir", { path: "." })]);
lg.afterTools([call1("read_file", { path: "a" })]);
checks.push(["loop: two repeats are fine", lg.afterTools([call1("list_dir", { path: "." })]) === undefined]);
const loopN = lg.afterTools([call1("list_dir", { path: "." })]);
checks.push(["loop: third identical call warns once", loopN?.kind === "loop" && lg.afterTools([call1("list_dir", { path: "." })]) === undefined]);
const lg2 = new Guards({ testsAvailable: false, maxOutputTokens: 1, callTimeoutS: 1 });
const spaced = ['{"command":"ls"}', '{"command":  "ls"}', '{ "command": "ls" }'].map((args) => lg2.afterTools([{ call: { id: "x", type: "function", function: { name: "bash", arguments: args } }, ok: true }]));
checks.push(["loop: argument whitespace doesn't hide a repeat", spaced[2]?.kind === "loop"]);

const vg = new Guards({ testsAvailable: true, maxOutputTokens: 1, callTimeoutS: 1 });
checks.push(["verify: no edits, no nudge", vg.beforeFinish() === undefined]);
vg.afterTools([call1("edit_file", { path: "a" })]);
vg.afterTools([call1("bash", { command: "python3 -m pytest -q" })]);
checks.push(["verify: tests via bash after the edit count", vg.beforeFinish() === undefined]);
vg.afterTools([call1("write_file", { path: "b" })]);
checks.push(["verify: edit after tests → one nudge", vg.beforeFinish()?.kind === "verify" && vg.beforeFinish() === undefined]);
const noTests = new Guards({ testsAvailable: false, maxOutputTokens: 1, callTimeoutS: 1 });
noTests.afterTools([call1("edit_file", { path: "a" })]);
checks.push(["verify: silent when the project has no tests", noTests.beforeFinish() === undefined]);

// ---- Integration: the loop against a scripted endpoint.
type Step = { msg?: any; finish?: string; delayMs?: number };
async function scripted(steps: Step[], cfg: Partial<Config> = {}) {
  let i = 0;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    requests.push(j);
    res.setHeader("Content-Type", "application/json");
    if (!j.tools) return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] }));
    const s = steps[i++] ?? { msg: { content: "done" } };
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (res.destroyed) return;
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...s.msg }, finish_reason: s.finish ?? (s.msg?.tool_calls ? "tool_calls" : "stop") }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const work = await mkdtemp(join(tmpdir(), "arcode-guards-"));
  const data = await mkdtemp(join(tmpdir(), "arcode-guards-data-"));
  const config = loadConfig({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKey: "x", model: "mock", workdir: work, dataDir: data, autoApprove: true, stream: false, ...cfg });
  const session = await Session.create(data, work, "mock", "t");
  const notices: string[] = [];
  const final = await runAgent("go", { config, session, approve: async () => true, onEvent: (e) => { if (e.type === "notice") notices.push(e.kind); } });
  server.closeAllConnections();
  server.close();
  return { final, session, notices, requests };
}

const trunc = await scripted([
  { msg: { content: null, reasoning: "thinking forever..." }, finish: "length" },
  { msg: { content: "real answer" } },
]);
checks.push(["truncated response isn't the answer; run continues", trunc.final === "real answer" && trunc.notices.includes("truncated") && trunc.session.meta.status === "done"]);
checks.push(["truncated partial not kept in context", !JSON.stringify(trunc.session.messages).includes("thinking forever")]);
checks.push(["max_tokens sent, capped at 8000 when not streaming", trunc.requests.filter((r) => r.tools).every((r) => r.max_tokens === 8000)]);

const slowCall = await scripted([
  { msg: { content: "too slow" }, delayMs: 1500 },
  { msg: { content: "fast answer" } },
], { callTimeoutS: 0.3, requestTimeoutS: 10 });
checks.push(["call over its time limit → notice and continue", slowCall.final === "fast answer" && slowCall.notices.includes("call_timeout")]);

const verify = await scripted([
  { msg: { content: null, tool_calls: [call("write_file", { path: "x.txt", content: "1" })] } },
  { msg: { content: "all done" } },
  { msg: { content: null, tool_calls: [call("run_tests", {})] } },
  { msg: { content: "tested and done" } },
], { testCmd: "true" });
checks.push(["finishing after an edit without tests → one verify nudge", verify.notices.filter((k) => k === "verify").length === 1 && verify.final === "tested and done"]);

const loop = await scripted([0, 1, 2].map(() => ({ msg: { content: null, tool_calls: [call("list_dir", {})] } })));
checks.push(["repeated identical calls → loop notice in the next request", loop.notices.includes("loop") && JSON.stringify(loop.requests.at(-1).messages).includes("harness_notice")]);

const offered = trunc.requests[0].tools.map((t: any) => t.function.name);
checks.push(["web_search hidden without a search provider", !offered.includes("web_search") && offered.includes("web_fetch")]);

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
