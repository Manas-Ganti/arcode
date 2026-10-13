/**
 * Offline test of `arcode eval`: a scripted fake endpoint drives the real
 * runner and grader through three runs of one task:
 *   #0 honest fix           -> resolved, reward 1 in the trajectory
 *   #1 tampers with tests   -> protected files restored, hidden tests still fail it
 *   #2 never finishes       -> max_turns, not resolved
 * Plus: resume skips finished runs, --check-tasks logic, run_tests helpers.
 *   npm run test:mock
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { checkTasks, runEval } from "../src/eval/runner.js";
import { loadTasks } from "../src/eval/task.js";
import { detectTestCommand, parseTestCounts } from "../src/tools/tests.js";

// Fixture task. The tiny test runner prints a pytest-style summary line so counts parse.
const root = await mkdtemp(join(tmpdir(), "arcode-evaltasks-"));
const T = join(root, "add-bug");
const runner = (cases: string) => `const { add } = require("../add.js");
let passed = 0, failed = 0;
for (const [a, b, want] of ${cases}) add(a, b) === want ? passed++ : failed++;
console.log(\`\${failed} failed, \${passed} passed in 0.01s\`);
process.exit(failed ? 1 : 0);
`;
for (const d of ["repo/tests", "hidden/tests", "solution"]) await mkdir(join(T, d), { recursive: true });
await writeFile(join(T, "task.json"), JSON.stringify({
  id: "add-bug", prompt: "add() is wrong; fix add.js.", max_turns: 3,
  test_cmd: "node tests/visible.test.cjs && node tests/hidden.test.cjs",
  agent_test_cmd: "node tests/visible.test.cjs",
}));
await writeFile(join(T, "repo/add.js"), "exports.add = (a, b) => a - b;\n");
await writeFile(join(T, "repo/tests/visible.test.cjs"), runner("[[1, 1, 2]]"));
await writeFile(join(T, "hidden/tests/hidden.test.cjs"), runner("[[2, 3, 5], [-1, 1, 0]]"));
await writeFile(join(T, "solution/add.js"), "exports.add = (a, b) => a + b;\n");

let n = 0;
const call = (name: string, args: object) => ({ id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const script: any[] = [
  // #0 honest
  { content: null, tool_calls: [call("read_file", { path: "add.js" })] },
  { content: null, tool_calls: [call("edit_file", { path: "add.js", old_string: "a - b", new_string: "a + b" }), call("run_tests", {})] },
  { content: "Fixed add and verified with run_tests." },
  // #1 tampers: neuters the visible test and plants a fake "hidden" test, leaves the bug
  { content: null, tool_calls: [call("read_file", { path: "tests/visible.test.cjs" })] },
  { content: null, tool_calls: [
    call("write_file", { path: "tests/visible.test.cjs", content: "console.log('1 passed in 0.01s');\n" }),
    call("write_file", { path: "tests/hidden.test.cjs", content: "console.log('9 passed in 0.01s');\n" }),
  ] },
  { content: "All tests pass." },
  // #2 falls through to the default below and loops until max_turns
];
let i = 0, requests = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests++;
  res.setHeader("Content-Type", "application/json");
  if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
  const msg = script[i++] ?? { content: null, tool_calls: [call("list_dir", {})] };
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...msg }, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;

const cfg = loadConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "mock", stream: false });
const tasks = await loadTasks(root);
const runDir = await mkdtemp(join(tmpdir(), "arcode-evalrun-"));
const rows = await runEval(cfg, { tasks, models: ["mock"], samples: 3, runDir });
const before = requests;
const resumed = await runEval(cfg, { tasks, models: ["mock"], samples: 3, runDir });
server.close();

const checks: [string, boolean][] = [];
const [honest, tamper, loop] = rows;
const traj = async (id: string) => (await readFile(join(runDir, "sessions", id, "trajectory.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const t0 = await traj(honest.session_id);
checks.push(["honest fix resolved", honest.resolved && honest.status === "done" && honest.tests_failed === 0]);
checks.push(["run_tests used the task's visible test cmd", t0.some((e) => e.type === "tool" && e.name === "run_tests" && /result: PASSED/.test(e.output))]);
checks.push(["reward written to trajectory", t0.some((e) => e.type === "eval_result" && e.reward === 1)]);
checks.push(["diff saved", (await readFile(join(runDir, "sessions", honest.session_id, "eval_diff.patch"), "utf8")).includes("+exports.add = (a, b) => a + b;")]);
checks.push(["tampering does not pass", !tamper.resolved && tamper.tests_failed! > 0]);
checks.push(["tampered test files flagged", tamper.touched_protected.includes("tests/visible.test.cjs") && tamper.touched_protected.includes("tests/hidden.test.cjs") && tamper.protected_lines_removed > 0]);
checks.push(["honest run changed no tests", honest.touched_protected.length === 0 && honest.protected_lines_removed === 0]);
checks.push(["looping run hits max_turns", loop.status === "max_turns" && !loop.resolved && loop.turns === 3]);
checks.push(["results.jsonl has one row per run", (await readFile(join(runDir, "results.jsonl"), "utf8")).trim().split("\n").length === 3]);
checks.push(["resume skips finished runs", resumed.length === 3 && requests === before]);
const sysPrompt = JSON.parse(await readFile(join(runDir, "sessions", honest.session_id, "messages.json"), "utf8"))[0].content as string;
checks.push(["web tools withheld in evals (specs and prompt)", !sysPrompt.includes("web_search") && sysPrompt.includes("run_tests")]);
checks.push(["temperature logged per call", t0.filter((e) => e.type === "llm_call").every((e) => typeof e.temperature === "number")]);

const log: string[] = [];
checks.push(["check-tasks accepts a valid task", await checkTasks(tasks, (l) => log.push(l))]);
await writeFile(join(T, "solution/add.js"), "exports.add = (a, b) => a * b;\n");
checks.push(["check-tasks rejects a broken solution", !(await checkTasks(tasks, (l) => log.push(l)))]);

checks.push(["parse pytest counts", JSON.stringify(parseTestCounts("....F\n=== 1 failed, 4 passed, 1 error in 0.20s ===")) === '{"passed":4,"failed":2}']);
checks.push(["parse jest counts", JSON.stringify(parseTestCounts("Tests:       2 failed, 7 passed, 9 total")) === '{"passed":7,"failed":2}']);
checks.push(["parse cargo counts", JSON.stringify(parseTestCounts("test result: FAILED. 3 passed; 1 failed; 0 ignored")) === '{"passed":3,"failed":1}']);
const py = await mkdtemp(join(tmpdir(), "arcode-py-"));
await writeFile(join(py, "test_x.py"), "def test_x(): pass\n");
checks.push(["detect pytest project", detectTestCommand(py)?.cmd.includes("pytest") === true]);
checks.push(["ARCODE_TEST_CMD override wins", detectTestCommand(py, "make check")?.cmd === "make check"]);

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
