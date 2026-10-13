import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvFile } from "../config.js";
import { LLM } from "../llm.js";
import { resolveModel } from "../models.js";
import { checkTasks, runEval, summarize } from "./runner.js";
import { loadTasks } from "./task.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EVAL_HELP = `arcode eval: run the agent on test-graded tasks and score it

  arcode eval --models GLM-5.3,DeepSeek-V4.1-Flash [--samples 1] [--only id,id] [--run <id>]
  arcode eval --check-tasks          baseline must fail, solution/ must pass (no model calls)

  --tasks <dir>     task directory (default: ${join("evals", "tasks")} in the arcode repo)
  --run <id>        results go to evals/results/<id>/; reusing an id resumes it
  --keep            keep the per-run workdirs for inspection`;

export async function evalMain(argv: string[]): Promise<void> {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (["check-tasks", "keep", "help"].includes(k)) a[k] = true;
    else if (["tasks", "models", "samples", "run", "only"].includes(k)) a[k] = argv[++i];
    else throw new Error(`unknown eval argument: ${argv[i]}\n\n${EVAL_HELP}`);
  }
  if (a.help) return console.log(EVAL_HELP);

  const tasks = await loadTasks(typeof a.tasks === "string" ? a.tasks : join(ROOT, "evals", "tasks"), typeof a.only === "string" ? a.only.split(",") : undefined);
  if (a["check-tasks"]) {
    const ok = await checkTasks(tasks, console.log);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  loadEnvFile();
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("ARC_API_KEY is not set (~/.arcode/.env)");
  const requested = typeof a.models === "string" ? a.models.split(",") : cfg.model ? [cfg.model] : [];
  if (!requested.length) throw new Error(`pass --models\n\n${EVAL_HELP}`);
  // Catch typos before spending a run on them.
  const listed = await new LLM(cfg.baseUrl, cfg.apiKey).listModels();
  const models = requested.map((m) => resolveModel(m.trim(), listed) ?? (() => { throw new Error(`not a listed model: ${m}`); })());

  const runId = typeof a.run === "string" ? a.run : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(ROOT, "evals", "results", runId);
  const samples = Number(a.samples ?? 1);
  console.log(`run ${runId}: ${tasks.length} tasks × ${models.length} models × ${samples} samples → ${runDir}`);
  const rows = await runEval(cfg, { tasks, models, samples, runDir, keepWorkdirs: Boolean(a.keep), log: console.log });
  console.log(`\n${summarize(rows)}`);
}
