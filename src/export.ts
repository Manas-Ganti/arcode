/**
 * `arcode export`: turn arcode sessions into fine-tuning data (one JSON object per line):
 *   { "messages": [...OpenAI chat format, with tool_calls / tool messages...],
 *     "tools": [...function specs the model was given...],
 *     "meta": { task, source, reward, model, turns, session, ... } }
 *
 * Sources it understands (searched recursively):
 *   - Harbor trials (integrations/harbor/jobs/...): reward from the trial's result.json;
 *     trials stopped by infrastructure (cancelled, environment errors) are skipped.
 *   - `arcode eval` runs (evals/results/...): reward from the trajectory's eval_result event.
 * Messages come from the session's messages.json, which is exactly the context the model
 * saw, as long as compaction never ran (sessions with compactions are skipped and counted).
 * Reasoning text is never included (it isn't stored in messages.json).
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Message, ToolSpec } from "./llm.js";
import { ALL_TOOLS, toSpecs } from "./tools/index.js";

export interface ExportOptions {
  minReward: number;
  /** Cap each tool result (head + tail kept); 0 = no cap. Use the same cap at inference. */
  maxToolChars: number;
  /** Task ids never to export (held-out evaluation tasks). */
  exclude: Set<string>;
}

export interface ExportStats { sessions: number; exported: number; skipped: Record<string, number> }

interface Found { dir: string; task: string; source: string; reward: number | null; skip?: string }

/** Find session dirs (they hold meta.json + messages.json + trajectory.jsonl) under the given paths. */
async function findSessions(root: string, out: string[] = []): Promise<string[]> {
  if (existsSync(join(root, "trajectory.jsonl")) && existsSync(join(root, "messages.json"))) return [...out, root];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") out = await findSessions(join(root, e.name), out);
  return out;
}

async function readJsonl(path: string): Promise<any[]> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Where the reward for a session lives, by layout. */
async function locate(dir: string, events: any[]): Promise<Found> {
  const evalResult = events.find((e) => e.type === "eval_result");
  if (evalResult) {
    const task = events.find((e) => e.type === "eval_task")?.task ?? evalResult.task;
    return { dir, task, source: "arcode-eval", reward: evalResult.reward ?? (evalResult.resolved ? 1 : 0) };
  }
  // Harbor: <trial>/agent/arcode/sessions/<id>/
  const trial = dirname(dirname(dirname(dirname(dir))));
  const resultPath = join(trial, "result.json");
  if (basename(dirname(dir)) === "sessions" && existsSync(resultPath)) {
    const r = JSON.parse(await readFile(resultPath, "utf8"));
    const exc: string = r.exception_info?.exception_type ?? "";
    const task = String(r.task_name ?? basename(trial)).replace(/^[^/]+\//, "");
    if (exc.startsWith("CancelledError") || exc.startsWith("Environment")) return { dir, task, source: r.source ?? "harbor", reward: null, skip: "infrastructure_interrupted" };
    const reward = r.verifier_result?.rewards?.reward;
    return { dir, task, source: r.source ?? "harbor", reward: typeof reward === "number" ? reward : null, skip: typeof reward === "number" ? undefined : "no_reward" };
  }
  return { dir, task: basename(dir), source: "interactive", reward: null, skip: "no_reward" };
}

export function capToolOutput(text: string, max: number): string {
  if (!max || text.length <= max) return text;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} chars omitted ...]\n${text.slice(-tail)}`;
}

/** Tool specs: logged in new sessions; for older ones, rebuilt from the tool names in the system prompt. */
function toolsFor(events: any[], messages: Message[]): { tools: ToolSpec[]; exact: boolean } {
  const logged = events.find((e) => e.type === "system_prompt")?.tools;
  if (logged) return { tools: logged, exact: true };
  const sys = messages[0]?.role === "system" ? messages[0].content : "";
  const names = new Set((sys.match(/^Tools: (.+)\.$/m)?.[1] ?? "").split(", ").map((s) => s.trim()));
  return { tools: toSpecs(ALL_TOOLS.filter((t) => names.has(t.name))), exact: false };
}

export async function exportSessions(paths: string[], outPath: string, opts: ExportOptions): Promise<ExportStats> {
  const stats: ExportStats = { sessions: 0, exported: 0, skipped: {} };
  const skip = (why: string) => { stats.skipped[why] = (stats.skipped[why] ?? 0) + 1; };
  const lines: string[] = [];
  for (const root of paths) {
    for (const dir of await findSessions(root)) {
      stats.sessions++;
      const events = await readJsonl(join(dir, "trajectory.jsonl"));
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
      const found = await locate(dir, events);
      if (found.skip) { skip(found.skip); continue; }
      if (opts.exclude.has(found.task)) { skip("held_out"); continue; }
      if ((found.reward ?? 0) < opts.minReward) { skip("below_min_reward"); continue; }
      if (meta.compactions > 0) { skip("compacted_context"); continue; }
      const messages: Message[] = JSON.parse(await readFile(join(dir, "messages.json"), "utf8"));
      const cleaned = messages.map((m) => (m.role === "tool" ? { ...m, content: capToolOutput(m.content, opts.maxToolChars) } : m));
      const { tools, exact } = toolsFor(events, messages);
      lines.push(JSON.stringify({
        messages: cleaned,
        tools,
        meta: {
          task: found.task, source: found.source, reward: found.reward, model: meta.model, status: meta.status,
          turns: meta.turns, session: meta.id, tools_exact: exact, tool_output_cap: opts.maxToolChars || null,
          temperature: events.find((e) => e.type === "llm_call")?.temperature ?? null,
        },
      }));
      stats.exported++;
    }
  }
  await writeFile(outPath, lines.join("\n") + (lines.length ? "\n" : ""));
  return stats;
}

export async function exportMain(argv: string[]): Promise<void> {
  const paths: string[] = [];
  let out = "arcode-sft.jsonl", minReward = 1, maxToolChars = 0;
  const exclude = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out = argv[++i];
    else if (a === "--min-reward") minReward = Number(argv[++i]);
    else if (a === "--max-tool-chars") maxToolChars = Number(argv[++i]);
    else if (a === "--exclude") for (const t of JSON.parse(await readFile(argv[++i], "utf8"))) exclude.add(String(t));
    else if (a === "-h" || a === "--help") {
      console.log(`arcode export <dirs...> [-o out.jsonl] [--min-reward 1] [--max-tool-chars N] [--exclude held_out.json]
  Turns arcode sessions (Harbor job dirs, evals/results) into chat-format fine-tuning data.
  --min-reward 0 exports failures too (with their reward in meta), e.g. for preference data.`);
      return;
    } else paths.push(a);
  }
  if (!paths.length) throw new Error("arcode export: give at least one directory (see --help)");
  const s = await exportSessions(paths, out, { minReward, maxToolChars, exclude });
  console.log(`${s.sessions} sessions found, ${s.exported} exported to ${out}`);
  for (const [why, n] of Object.entries(s.skipped)) console.log(`  skipped ${n}: ${why}`);
}
