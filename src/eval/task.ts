import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One eval task, a directory:
 *   task.json   { id, prompt, test_cmd, ... } (see EvalTask)
 *   repo/       starting code: the only thing the agent sees
 *   hidden/     grading tests, overlaid onto the workdir after the agent stops
 *   solution/   reference fix, overlaid onto repo/ by `--check-tasks` only
 */
export interface EvalTask {
  id: string;
  prompt: string;
  /** Grading command, run in the workdir after hidden/ is overlaid. Exit 0 = resolved. */
  test_cmd: string;
  /** Overrides run_tests' auto-detection while the agent works. */
  agent_test_cmd?: string;
  max_turns?: number;
  timeout_s?: number;
  tags?: string[];
  /** Regex (string) of paths restored before grading; default PROTECTED. */
  protected?: string;
  dir: string;
}

/** Test files and test config: restored to the original before grading, so editing them can't buy a pass. */
export const PROTECTED =
  /(^|\/)(tests?\/|test_[^/]*\.py$|[^/]*_test\.(py|go)$|[^/]*\.(test|spec)\.[cm]?[jt]s$|conftest\.py$|pytest\.ini$|tox\.ini$|setup\.cfg$|pyproject\.toml$)/;

export async function loadTasks(root: string, only?: string[]): Promise<EvalTask[]> {
  const tasks: EvalTask[] = [];
  for (const name of (await readdir(root)).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "task.json"))) continue;
    const t = { ...JSON.parse(await readFile(join(dir, "task.json"), "utf8")), dir } as EvalTask;
    const missing = (["id", "prompt", "test_cmd"] as const).filter((k) => !t[k]);
    if (missing.length) throw new Error(`${dir}/task.json: missing ${missing.join(", ")}`);
    if (!existsSync(join(dir, "repo"))) throw new Error(`${dir}: no repo/ directory`);
    if (!only || only.includes(t.id)) tasks.push(t);
  }
  if (only) {
    const unknown = only.filter((id) => !tasks.some((t) => t.id === id));
    if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(", ")}`);
  }
  return tasks;
}
