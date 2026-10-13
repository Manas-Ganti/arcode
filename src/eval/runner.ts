import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { runAgent } from "../agent.js";
import { Session } from "../session.js";
import { ALL_TOOLS } from "../tools/index.js";
import { runCommand } from "../tools/shell.js";
import { checkTask, grade, prepareWorkdir } from "./grade.js";
import type { EvalTask } from "./task.js";

/** No web tools in evals: they would let the model look up solutions. */
export const EVAL_TOOLS = ALL_TOOLS.filter((t) => !t.name.startsWith("web_"));

export interface EvalOptions {
  tasks: EvalTask[];
  models: string[];
  samples: number;
  /** evals/results/<runId>/ — reusing a runId resumes it. */
  runDir: string;
  keepWorkdirs?: boolean;
  log?: (line: string) => void;
}

export interface ResultRow {
  task: string;
  model: string;
  sample: number;
  resolved: boolean;
  tests_passed: number | null;
  tests_failed: number | null;
  status: string;
  turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  tool_calls: number;
  tool_errors: number;
  wall_s: number;
  touched_protected: string[];
  protected_lines_removed: number;
  diff_stat: string;
  session_id: string;
  temperature: number;
  harness_commit: string;
  finished_at: string;
  error?: string;
}

export async function runEval(base: Config, opts: EvalOptions): Promise<ResultRow[]> {
  const log = opts.log ?? (() => {});
  await mkdir(opts.runDir, { recursive: true });
  const resultsPath = join(opts.runDir, "results.jsonl");
  const rows: ResultRow[] = existsSync(resultsPath)
    ? (await readFile(resultsPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const done = new Set(rows.map((r) => key(r.task, r.model, r.sample)));
  const harness_commit = await harnessCommit();

  for (const model of opts.models) {
    for (const task of opts.tasks) {
      for (let sample = 0; sample < opts.samples; sample++) {
        if (done.has(key(task.id, model, sample))) continue;
        const row = await runOne(base, task, model, sample, opts, harness_commit);
        rows.push(row);
        await appendFile(resultsPath, JSON.stringify(row) + "\n");
        log(`${row.resolved ? "PASS" : "FAIL"}  ${task.id.padEnd(28)} ${model.padEnd(34)} #${sample}  ${row.status.padEnd(9)} turns ${String(row.turns).padStart(2)}  ${row.wall_s}s${row.touched_protected.length ? (row.protected_lines_removed ? `  [CHANGED existing tests: -${row.protected_lines_removed} lines]` : "  [added tests]") : ""}${row.error ? `  ${row.error.slice(0, 80)}` : ""}`);
      }
    }
  }
  return rows;
}

async function runOne(base: Config, task: EvalTask, model: string, sample: number, opts: EvalOptions, harness_commit: string): Promise<ResultRow> {
  const work = await prepareWorkdir(task);
  const config: Config = {
    ...base,
    model,
    summaryModel: model,
    workdir: work,
    dataDir: opts.runDir,
    autoApprove: true,
    maxTurns: task.max_turns ?? base.maxTurns,
    testCmd: task.agent_test_cmd,
  };
  const session = await Session.create(opts.runDir, work, model, task.prompt);
  await session.log({ type: "eval_task", task: task.id, sample, tags: task.tags ?? [] });
  const t0 = Date.now();
  let error: string | undefined;
  try {
    await runAgent(task.prompt, { config, session, tools: EVAL_TOOLS, approve: async () => true });
  } catch (e: any) {
    error = e?.message ?? String(e);
    session.meta.status = "error";
    await session.log({ type: "error", message: error, body: e?.body });
    await session.save();
  }
  const wall_s = Math.round((Date.now() - t0) / 100) / 10;

  const g = await grade(task, work);
  // The reward goes into the trajectory too, so every eval run is labelled RL/SFT data.
  await session.log({ type: "eval_result", task: task.id, resolved: g.resolved, reward: g.resolved ? 1 : 0, tests_passed: g.tests_passed, tests_failed: g.tests_failed, touched_protected: g.touched_protected, protected_lines_removed: g.protected_lines_removed });
  await writeFile(join(session.dir, "eval_diff.patch"), g.diff);
  await writeFile(join(session.dir, "eval_grade_output.txt"), g.grade_output);
  if (!opts.keepWorkdirs) await rm(work, { recursive: true, force: true });

  const traj = (await readFile(join(session.dir, "trajectory.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tools = traj.filter((e) => e.type === "tool");
  return {
    task: task.id,
    model,
    sample,
    resolved: g.resolved,
    tests_passed: g.tests_passed,
    tests_failed: g.tests_failed,
    status: session.meta.status,
    turns: session.meta.turns,
    prompt_tokens: session.meta.usage.prompt,
    completion_tokens: session.meta.usage.completion,
    tool_calls: tools.length,
    tool_errors: tools.filter((e) => !e.ok).length,
    wall_s,
    touched_protected: g.touched_protected,
    protected_lines_removed: g.protected_lines_removed,
    diff_stat: g.diff_stat,
    session_id: session.meta.id,
    temperature: config.temperature,
    harness_commit,
    finished_at: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

export function summarize(rows: ResultRow[]): string {
  const models = [...new Set(rows.map((r) => r.model))];
  const lines = ["model                               resolved        turns  tokens/run  tool err  max_turns  changed-tests"];
  for (const m of models) {
    const rs = rows.filter((r) => r.model === m);
    const n = rs.length;
    const solved = rs.filter((r) => r.resolved).length;
    const avg = (f: (r: ResultRow) => number) => rs.reduce((s, r) => s + f(r), 0) / n;
    const calls = rs.reduce((s, r) => s + r.tool_calls, 0);
    lines.push(
      `${m.padEnd(34)}  ${`${solved}/${n} (${Math.round((100 * solved) / n)}%)`.padEnd(14)}  ${avg((r) => r.turns).toFixed(1).padStart(5)}  ${Math.round(avg((r) => r.prompt_tokens + r.completion_tokens)).toString().padStart(10)}  ${(calls ? (100 * rs.reduce((s, r) => s + r.tool_errors, 0)) / calls : 0).toFixed(0).padStart(7)}%  ${String(rs.filter((r) => r.status === "max_turns").length).padStart(9)}  ${String(rs.filter((r) => (r.protected_lines_removed ?? r.touched_protected.length) > 0).length).padStart(13)}`,
    );
  }
  return lines.join("\n");
}

export async function checkTasks(tasks: EvalTask[], log: (line: string) => void): Promise<boolean> {
  let ok = true;
  for (const t of tasks) {
    const r = await checkTask(t);
    const good = r.baselineFails && r.solutionPasses !== false;
    ok &&= good;
    const baseline = r.baselineFails ? "tests fail (good)" : "did NOT fail with failing tests (trivial task, or tests could not run)";
    log(`${good ? "ok  " : "BAD "} ${t.id.padEnd(28)} baseline ${baseline} · solution ${r.solutionPasses === null ? "not checked" : r.solutionPasses ? "passes" : "FAILS"}${!good && r.detail ? `\n${r.detail}` : ""}`);
  }
  return ok;
}

const key = (task: string, model: string, sample: number) => `${task}|${model}|${sample}`;

/** arcode's own commit (+ "-dirty"), so results can be tied to the harness version that produced them. */
async function harnessCommit(): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const head = await runCommand("git rev-parse --short HEAD", root, 10_000);
  if (head.code !== 0) return "unknown";
  const dirty = (await runCommand("git status --porcelain", root, 10_000)).out.trim() ? "-dirty" : "";
  return head.out.trim() + dirty;
}
