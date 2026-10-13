#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, loadEnvFile, type Config } from "./config.js";
import { defaultContextBudget, modelSpec, resolveModel } from "./models.js";
import { LLM } from "./llm.js";
import { Session } from "./session.js";
import { runAgent, type AgentEvent } from "./agent.js";
import { compact } from "./context.js";
import { evalMain } from "./eval/main.js";
import { MarkdownStream, renderMarkdown } from "./markdown.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const HELP = `arcode - minimal coding agent for OpenAI-compatible endpoints

Usage:
  arcode                         interactive session in the current directory
  arcode -p "task"               run one task headless and exit
  arcode --continue              resume the latest session for this directory
  arcode --resume <id>           resume a specific session
  arcode --sessions              list sessions
  arcode --models                list models available on the endpoint
  arcode eval --help             score the agent on test-graded tasks

Options:
  -m, --model <id>               model id (or ARCODE_MODEL)
  -y, --yes                      auto-approve shell commands and file writes
  --show-reasoning               print model reasoning text when present
  --max-turns <n>                cap on agent turns per task

Env (or ~/.arcode/.env): ARC_API_KEY, ARC_BASE_URL, ARCODE_MODEL, ARCODE_EXTRA_BODY, BRAVE_API_KEY | TAVILY_API_KEY | SEARXNG_URL

In the REPL: /plan  /notes  /compact  /model [n|id]  /session  /help  exit (or /exit, Ctrl+D)
  /model with no argument lists the endpoint's models to pick from.`;

function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "-p": case "--prompt": a.prompt = next(); break;
      case "-m": case "--model": a.model = next(); break;
      case "-y": case "--yes": a.yes = true; break;
      case "--continue": case "-c": a.continue = true; break;
      case "--resume": a.resume = next(); break;
      case "--sessions": a.sessions = true; break;
      case "--models": a.models = true; break;
      case "--show-reasoning": a.reasoning = true; break;
      case "--max-turns": a.maxTurns = next(); break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  return a;
}

let modelCache: string[] | undefined;
/** Chat models on the endpoint (embedding models filtered out), fetched once per process. */
async function chatModels(cfg: Config): Promise<string[]> {
  modelCache ??= (await new LLM(cfg.baseUrl, cfg.apiKey).listModels()).filter((m) => !/embed/i.test(m));
  return modelCache;
}

function defaultModel(models: string[]): string {
  const pref = models.find((m) => /glm/i.test(m)) ?? models.find((m) => /deepseek/i.test(m)) ?? models[0];
  if (!pref) throw new Error("endpoint returned no models; pass --model");
  return pref;
}

/** Numbered picker. Enter keeps `current`; returns undefined on an invalid choice. */
async function chooseModel(rl: Interface, models: string[], current: string): Promise<string | undefined> {
  const w = Math.max(...models.map((m) => m.length));
  models.forEach((m, i) => {
    const s = modelSpec(m);
    const ctx = s.known ? `${s.contextWindow / 1000}k` : "?";
    const line = `${m === current ? "*" : " "} ${String(i + 1).padStart(2)}  ${m.padEnd(w)}  ${ctx}`;
    console.log(m === current ? c.cyan(line) : line);
  });
  const ans = (await rl.question(c.dim(`model [1-${models.length}, Enter keeps ${current}]: `))).trim();
  if (!ans) return current;
  return resolveModel(ans, models);
}

function renderer(showReasoning: boolean) {
  // Per model call: what was already streamed, so the full-text events don't repeat it.
  let streamed = { content: false, reasoning: false };
  let lineKind: "content" | "reasoning" | "status" | undefined; // what the cursor is in the middle of
  // Markdown is styled only on a terminal; piped output stays raw markdown.
  const tty = Boolean(stdout.isTTY);
  let md = new MarkdownStream(stdout.columns || 80);
  // Spinner while the model is working: elapsed time, hidden reasoning progress, silence and retries.
  let spin: { timer: ReturnType<typeof setInterval>; start: number; model: string; reasoning: number; lastData: number; retry?: string } | undefined;
  const drawSpin = () => {
    if (!spin) return;
    const now = Date.now();
    const frame = SPINNER[Math.floor((now - spin.start) / 80) % SPINNER.length];
    const parts = [`thinking · ${spin.model} · ${Math.floor((now - spin.start) / 1000)}s`];
    if (spin.reasoning) parts.push(`reasoning ${spin.reasoning >= 1000 ? `${(spin.reasoning / 1000).toFixed(1)}k` : spin.reasoning} chars`);
    const quiet = Math.floor((now - spin.lastData) / 1000);
    if (quiet >= 15) parts.push(spin.reasoning ? `no new tokens for ${quiet}s` : "waiting for the model");
    if (spin.retry) parts.push(spin.retry);
    const text = `${frame} ${parts.join(" · ")}`.slice(0, (stdout.columns || 80) - 1);
    stdout.write(`\r\x1b[2K${c.cyan(text.slice(0, 1))}${c.dim(text.slice(1))}`);
  };
  const stopSpin = () => {
    if (spin) clearInterval(spin.timer);
    spin = undefined;
  };
  const endLine = () => {
    stopSpin();
    if (lineKind === "status") stdout.write("\r\x1b[2K");
    else if (lineKind === "content" && tty) stdout.write(md.flush() + "\n");
    else if (lineKind) stdout.write("\n");
    lineKind = undefined;
  };
  return (e: AgentEvent) => {
    if (e.type === "llm_retry") {
      if (spin) spin.retry = `retry ${e.attempt} (${e.reason}${e.status ? ` ${e.status}` : ""})`;
      return;
    }
    if (e.type === "delta") {
      if (spin) spin.lastData = Date.now();
      if (e.kind === "reasoning" && !showReasoning) {
        if (spin) spin.reasoning += e.text.length; // the spinner shows it; keep the line up
        return;
      }
      if (lineKind !== e.kind) endLine();
      stdout.write(e.kind === "reasoning" ? c.dim(e.text) : tty ? md.push(e.text) : e.text);
      streamed[e.kind] = true;
      lineKind = e.kind;
      return;
    }
    endLine();
    switch (e.type) {
      case "llm_start":
        streamed = { content: false, reasoning: false };
        md = new MarkdownStream(stdout.columns || 80);
        if (stdout.isTTY) {
          const now = Date.now();
          spin = { timer: setInterval(drawSpin, 80), start: now, model: e.model, reasoning: 0, lastData: now };
          drawSpin();
          lineKind = "status";
        }
        break;
      case "reasoning": if (showReasoning && !streamed.reasoning) console.log(c.dim(e.text.trim())); break;
      case "assistant_text": if (!streamed.content) console.log(tty ? renderMarkdown(e.text.trim()) : e.text.trim()); break;
      case "tool_start": {
        const arg = e.args.command ?? e.args.path ?? e.args.query ?? e.args.url ?? e.args.pattern ?? "";
        console.log(c.cyan(`● ${e.name}`) + (arg ? c.dim(` ${String(arg).slice(0, 120)}`) : ""));
        break;
      }
      case "tool_end": {
        const first = e.result.split("\n").slice(0, 3).join("\n");
        console.log(c.dim(`  ${first.replace(/\n/g, "\n  ").slice(0, 400)}${e.result.length > first.length ? " …" : ""} (${e.ms}ms)`));
        break;
      }
      case "compaction": console.log(c.yellow("↻ context compacted")); break;
      case "done": if (e.status !== "done") console.log(c.yellow(`stopped: ${e.status}`)); break;
    }
  };
}

async function main() {
  if (process.argv[2] === "eval") return evalMain(process.argv.slice(3));
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);

  loadEnvFile();
  const cfg = loadConfig();
  if (args.yes) cfg.autoApprove = true;
  if (args.maxTurns) cfg.maxTurns = Number(args.maxTurns);
  if (typeof args.model === "string") cfg.model = cfg.summaryModel = args.model;

  if (args.sessions) {
    for (const s of await Session.list(cfg.dataDir)) {
      console.log(`${s.id}  ${s.status.padEnd(11)} ${s.model.padEnd(24)} ${s.workdir}\n  ${c.dim(s.task.slice(0, 100))}`);
    }
    return;
  }
  if (!cfg.apiKey) throw new Error("ARC_API_KEY is not set: put it in ~/.arcode/.env or the environment (get one at llm.arc.vt.edu > Settings > Account > API keys)");
  if (args.models) return console.log((await new LLM(cfg.baseUrl, cfg.apiKey).listModels()).join("\n"));

  // Resume or start fresh.
  let session: Session | undefined;
  const resumeId = typeof args.resume === "string" ? args.resume : args.continue ? await Session.latest(cfg.dataDir, cfg.workdir) : undefined;
  if (resumeId) {
    session = await Session.load(cfg.dataDir, resumeId);
    cfg.model ||= session.meta.model;
    cfg.summaryModel ||= cfg.model;
    session.messages.push({ role: "user", content: `[Session resumed. Files may have changed since; re-read before editing.]\n${session.stateBlock()}` });
    session.messages.push({ role: "assistant", content: "Resumed. I'll re-read files before editing." });
    console.log(c.dim(`resumed ${session.meta.id}\n${session.renderTodos()}`));
  }
  const rl: Interface | undefined = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  // Interactive with no model configured: let the user pick (Enter takes the default).
  if (!cfg.model) {
    const models = await chatModels(cfg);
    cfg.model = defaultModel(models);
    if (rl && typeof args.prompt !== "string") cfg.model = (await chooseModel(rl, models, cfg.model)) ?? cfg.model;
  }
  // The summary model follows the main model unless ARCODE_SUMMARY_MODEL pins it.
  const pinnedSummary = Boolean(process.env.ARCODE_SUMMARY_MODEL);
  cfg.summaryModel ||= cfg.model;
  warnUnknownModel(cfg.model);

  /** One place for everything model-dependent; the key and endpoint are shared by all models. */
  const setModel = (id: string) => {
    cfg.model = id;
    if (!pinnedSummary) cfg.summaryModel = id;
    if (session) session.meta.model = id; // per-call model stays in trajectory llm_call events
    warnUnknownModel(id);
    console.log(c.dim(`model → ${id} (compaction budget ~${Math.round((cfg.contextBudget || defaultContextBudget(id)) / 1000)}k tokens)`));
  };
  const approve = async (summary: string) => {
    if (!rl) return false; // headless without --yes: deny side effects
    const ans = (await rl.question(c.yellow(`allow ${summary}? [y/N/a=always] `)).catch(() => "")).trim().toLowerCase(); // closed stdin = deny
    if (ans === "a") {
      cfg.autoApprove = true;
      console.log(c.dim("  auto-approving file edits and commands for the rest of this session"));
      return true;
    }
    return ans === "y" || ans === "yes";
  };
  const onEvent = renderer(Boolean(args.reasoning));

  const run = async (input: string) => {
    session ??= await Session.create(cfg.dataDir, cfg.workdir, cfg.model, input);
    try {
      await runAgent(input, { config: cfg, session, approve, onEvent });
    } catch (e: any) {
      onEvent({ type: "done", status: "error", finalText: "" }); // stops the spinner before printing the error
      session.meta.status = "error";
      await session.log({ type: "error", message: e?.message, body: e?.body });
      await session.save();
      console.error(c.red(`error: ${e?.message}${e?.body ? `\n${String(e.body).slice(0, 800)}` : ""}`));
    }
    const u = session.meta.usage;
    console.log(c.dim(`[${session.meta.model} · turns ${session.meta.turns} · tokens ${u.prompt}+${u.completion} · ${session.meta.id}]`));
  };

  if (typeof args.prompt === "string") {
    await run(args.prompt);
    rl?.close();
    process.exitCode = session?.meta.status === "done" ? 0 : 1;
    return;
  }
  if (!rl) throw new Error("no TTY: use -p \"task\" for headless runs");

  console.log(c.bold("arcode") + c.dim(` · ${cfg.model} · ${cfg.workdir} · /help · exit to quit`));
  let closed = false;
  rl.on("close", () => { closed = true; });
  while (!closed) {
    let line: string;
    try { line = (await rl.question(c.bold("› "))).trim(); } catch { break; }
    if (!line) continue;
    if (/^(exit|quit)$/i.test(line)) break; // bare words, like a shell; /exit works too
    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help") console.log(HELP);
      else if (cmd === "plan") console.log(session?.renderTodos() ?? "(no session yet)");
      else if (cmd === "notes") console.log(session?.notes.map((n) => `- ${n}`).join("\n") || "(none)");
      else if (cmd === "session") console.log(session ? `${session.dir}\n${JSON.stringify(session.meta, null, 2)}` : "(no session yet)");
      else if (cmd === "model") {
        const models = await chatModels(cfg).catch(() => [] as string[]);
        const picked = rest[0] ? (models.length ? resolveModel(rest[0], models) : rest[0]) : models.length ? await chooseModel(rl, models, cfg.model) : undefined;
        if (picked && picked !== cfg.model) setModel(picked);
        else if (!picked) console.log(c.yellow(`not a listed model${rest[0] ? `: ${rest[0]}` : ""}; /model shows the list`));
        else console.log(c.dim(`model: ${cfg.model}`));
      }
      else if (cmd === "compact" && session) {
        const did = await compact({ llm: new LLM(cfg.baseUrl, cfg.apiKey, cfg.extraBody, cfg.requestTimeoutS * 1000), model: cfg.summaryModel, session });
        await session.save();
        console.log(did ? "compacted" : "nothing to compact");
      } else console.log(`unknown command /${cmd}`);
      continue;
    }
    await run(line);
  }
  rl.close();
  if (session && session.meta.status === "running") { session.meta.status = "interrupted"; await session.save(); }
}

function warnUnknownModel(id: string) {
  if (!modelSpec(id).known) console.log(c.dim(`note: ${id} is not in models.ts; assuming a ${modelSpec(id).contextWindow / 1000}k context and no extra params`));
}

main().catch((e) => {
  console.error(c.red(e?.message ?? String(e)));
  process.exit(1);
});
