/**
 * Offline test of `arcode export`: Harbor trials (reward from result.json, infra interruptions
 * skipped), arcode-eval sessions (reward from eval_result), held-out exclusion, compaction skip,
 * tool-output capping, and tool specs from the logged system_prompt event.
 *   npm run test:mock
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capToolOutput, exportSessions } from "../src/export.js";

const root = await mkdtemp(join(tmpdir(), "arcode-export-"));
const msgs = (task: string) => [
  { role: "system", content: "You are arcode.\nTools: read_file, bash.\n" },
  { role: "user", content: `fix ${task}` },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
  { role: "tool", tool_call_id: "c1", content: "x".repeat(500) },
  { role: "assistant", content: "done" },
];
async function session(dir: string, task: string, opts: { events?: object[]; compactions?: number } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ id: task, model: "m", status: "done", turns: 2, compactions: opts.compactions ?? 0 }));
  await writeFile(join(dir, "messages.json"), JSON.stringify(msgs(task)));
  await writeFile(join(dir, "trajectory.jsonl"), [{ type: "session_start" }, ...(opts.events ?? [])].map((e) => JSON.stringify(e)).join("\n") + "\n");
}
async function harborTrial(name: string, reward: number | null, exc?: string, extra: Parameters<typeof session>[2] = {}) {
  const trial = join(root, "jobs", "j1", `${name}__abc`);
  await mkdir(trial, { recursive: true });
  await writeFile(join(trial, "result.json"), JSON.stringify({ task_name: `swe-rebench/${name}`, source: "swe-rebench/x", verifier_result: reward === null ? null : { rewards: { reward } }, exception_info: exc ? { exception_type: exc } : null }));
  await session(join(trial, "agent", "arcode", "sessions", name), name, extra);
}

await harborTrial("solved-1", 1, undefined, { events: [{ type: "system_prompt", content: "s", tools: [{ type: "function", function: { name: "bash", description: "d", parameters: {} } }] }] });
await harborTrial("failed-1", 0);
await harborTrial("cancelled-1", 0, "CancelledError");
await harborTrial("timeout-solved", 1, "AgentTimeoutError");
await harborTrial("heldout-1", 1);
await harborTrial("compacted-1", 1, undefined, { compactions: 1 });
await session(join(root, "evals", "run", "sessions", "e1"), "e1", { events: [{ type: "eval_task", task: "pager" }, { type: "eval_result", task: "pager", resolved: true, reward: 1 }] });

const out = join(root, "out.jsonl");
const stats = await exportSessions([root], out, { minReward: 1, maxToolChars: 100, exclude: new Set(["heldout-1"]) });
const rows = (await readFile(out, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const byTask = Object.fromEntries(rows.map((r) => [r.meta.task, r]));

const checks: [string, boolean][] = [
  ["harbor reward from result.json; failures filtered", "solved-1" in byTask && !("failed-1" in byTask)],
  ["infrastructure interruptions skipped", stats.skipped.infrastructure_interrupted === 1],
  ["task time-limit runs still count if the tests passed", "timeout-solved" in byTask],
  ["held-out tasks excluded", !("heldout-1" in byTask) && stats.skipped.held_out === 1],
  ["compacted sessions skipped", stats.skipped.compacted_context === 1],
  ["arcode-eval reward from eval_result", byTask.pager?.meta.source === "arcode-eval"],
  ["tool outputs capped", byTask["solved-1"].messages[3].content.length < 200 && byTask["solved-1"].messages[3].content.includes("omitted")],
  ["exact tool specs from system_prompt event", byTask["solved-1"].meta.tools_exact && byTask["solved-1"].tools[0].function.name === "bash"],
  ["older sessions: specs rebuilt from the prompt's tool list", !byTask.pager.meta.tools_exact && byTask.pager.tools.map((t: any) => t.function.name).join() === "read_file,bash"],
  ["assistant tool calls preserved", byTask["solved-1"].messages[2].tool_calls[0].function.name === "bash"],
  ["cap leaves short text alone", capToolOutput("abc", 100) === "abc"],
  // 7 sessions: the interrupted and the compacted one are still skipped, so 5 (including the failure).
  ["--min-reward 0 exports failures with their reward", (await exportSessions([root], out, { minReward: 0, maxToolChars: 0, exclude: new Set() })).exported === 5],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
