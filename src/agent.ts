import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import type { Config } from "./config.js";
import { LLM, type Message, type ToolCall } from "./llm.js";
import { Session } from "./session.js";
import { ALL_TOOLS, toSpecs, type Tool, type ToolContext } from "./tools/index.js";
import { compact, estimateTokens } from "./context.js";
import { defaultContextBudget } from "./models.js";
import { Guards, noticeMessage, type Notice } from "./guards.js";
import { detectTestCommand } from "./tools/tests.js";

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "llm_start"; model: string }
  | { type: "llm_retry"; attempt: number; reason: string; status?: number }
  | { type: "notice"; kind: string; text: string }
  /** Streamed fragment; `assistant_text`/`reasoning` still follow with the full text. */
  | { type: "delta"; kind: "content" | "reasoning"; text: string }
  | { type: "tool_start"; name: string; args: any }
  | { type: "tool_end"; name: string; result: string; ms: number }
  | { type: "compaction" }
  | { type: "done"; status: Session["meta"]["status"]; finalText: string };

export interface AgentOptions {
  config: Config;
  session: Session;
  tools?: Tool[];
  approve: ToolContext["approve"];
  onEvent?: (e: AgentEvent) => void;
  /** Aborts the run (e.g. an eval time limit): checked between turns and passed to model calls. */
  signal?: AbortSignal;
}

const PROJECT_FILES = ["ARCODE.md", "AGENTS.md", "CLAUDE.md"];

export async function buildSystemPrompt(config: Config, tools: Tool[]): Promise<string> {
  let project = "";
  for (const f of PROJECT_FILES) {
    const text = await readFile(join(config.workdir, f), "utf8").catch(() => "");
    if (text) { project = `\n\n<project_instructions file="${f}">\n${text.slice(0, 12_000)}\n</project_instructions>`; break; }
  }
  return `You are arcode, a coding agent working in a real repository through tools.

Environment: workspace root ${config.workdir} (${platform()}). Today is ${new Date().toISOString().slice(0, 10)}.
Tools: ${tools.map((t) => t.name).join(", ")}.

How to work:
- For anything beyond a one-step change, call todo_write first with a short plan, and keep it updated.
- Explore before editing: list_dir / grep / read_file. Never guess file contents.
- Edit with edit_file (exact string replacement). Use write_file only for new files.
- After changes, verify with run_tests (and bash for type-checkers, builds, or running the program). Fix what fails, and run the tests again before you finish.
${tools.some((t) => t.name === "web_search") ? "- Use web_search + web_fetch when unsure about a library API, an error, or anything version-specific.\n" : ""}- Save durable facts (decisions, key paths, working commands) with note; they survive context compaction.
- Keep messages short. When the task is complete, reply with a brief summary of what changed and how you verified it, and make no further tool calls.${project}`;
}

export async function runAgent(userInput: string, opts: AgentOptions): Promise<string> {
  const { config, session, approve, onEvent = () => {} } = opts;
  // web_search can't work without a search provider; don't offer it (models call it anyway).
  const tools = (opts.tools ?? ALL_TOOLS).filter((t) => t.name !== "web_search" || config.search.provider !== "none");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = toSpecs(tools);
  const llm = new LLM(config.baseUrl, config.apiKey, config.extraBody, config.requestTimeoutS * 1000);
  const ctx: ToolContext = {
    config,
    session,
    // Checked per call, so "always allow" chosen mid-task applies to the rest of that task too.
    approve: async (summary) => config.autoApprove || approve(summary),
  };

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: await buildSystemPrompt(config, tools) });
  }
  session.messages.push({ role: "user", content: userInput });
  await session.log({ type: "user", content: userInput });
  session.meta.status = "running";

  const guards = new Guards({
    deadlineS: config.deadlineS,
    testsAvailable: Boolean(detectTestCommand(config.workdir, config.testCmd)),
    maxOutputTokens: config.maxOutputTokens,
    callTimeoutS: config.callTimeoutS,
  });
  /** A harness notice reaches the model as a user message, and the trajectory as a `notice` event. */
  const notify = async (n: Notice) => {
    session.messages.push({ role: "user", content: noticeMessage(n) });
    await session.log({ type: "notice", kind: n.kind, text: n.text });
    onEvent({ type: "notice", kind: n.kind, text: n.text });
  };

  let finalText = "";
  for (let turn = 0; turn < config.maxTurns; turn++) {
    if (opts.signal?.aborted) throw new Error("run aborted (time limit)");
    const deadline = guards.beforeCall();
    if (deadline) await notify(deadline);
    if (estimateTokens(session.messages) > (config.contextBudget || defaultContextBudget(config.model))) {
      if (await compact({ llm, model: config.summaryModel, session })) onEvent({ type: "compaction" });
    }

    onEvent({ type: "llm_start", model: config.model });
    // Streamed sizes so far: if the call fails or is cut off, they show a stall (0) vs a runaway generation.
    const streamedChars = { content: 0, reasoning: 0 };
    const callStart = Date.now();
    const callTimer = AbortSignal.timeout(config.callTimeoutS * 1000);
    let res;
    try {
      res = await llm.chat({
        model: config.model,
        messages: session.messages,
        tools: specs,
        temperature: config.temperature,
        // ARC's proxy rejects max_tokens > 8000 on non-streamed requests.
        maxTokens: config.stream ? config.maxOutputTokens : Math.min(config.maxOutputTokens, 8000),
        signal: opts.signal ? AbortSignal.any([opts.signal, callTimer]) : callTimer,
        onRetry: (r) => {
          void session.log({ type: "llm_retry", model: config.model, ...r });
          onEvent({ type: "llm_retry", attempt: r.attempt, reason: r.reason, status: r.status });
        },
        onDelta: config.stream
          ? (d) => {
              if ("content" in d) { streamedChars.content += d.content.length; onEvent({ type: "delta", kind: "content", text: d.content }); }
              else { streamedChars.reasoning += d.reasoning.length; onEvent({ type: "delta", kind: "reasoning", text: d.reasoning }); }
            }
          : undefined,
      });
    } catch (e: any) {
      await session.log({
        type: "llm_aborted", model: config.model, elapsed_ms: Date.now() - callStart, message: e?.message ?? String(e),
        streamed_content_chars: streamedChars.content, streamed_reasoning_chars: streamedChars.reasoning,
      });
      // A single call running past its limit is recoverable; the whole run's limit is not.
      if (callTimer.aborted && !opts.signal?.aborted) { session.meta.turns++; await notify(guards.callTimeout()); continue; }
      throw e;
    }
    let msg = res.message;
    if (!msg.tool_calls?.length && msg.content) msg = recoverTextToolCalls(msg, byName);

    session.meta.turns++;
    session.meta.usage.prompt += res.usage?.prompt_tokens ?? 0;
    session.meta.usage.completion += res.usage?.completion_tokens ?? 0;
    await session.log({
      type: "llm_call",
      model: config.model,
      temperature: config.temperature,
      finish_reason: res.finishReason,
      usage: res.usage,
      latency_ms: res.latencyMs,
      attempts: res.attempts,
      context_tokens_est: estimateTokens(session.messages),
      message: msg,
    });

    // Cut off by the output cap with nothing actionable: discard it rather than treat it as the answer.
    if (res.finishReason === "length" && !msg.tool_calls?.length) {
      await notify(guards.truncated());
      continue;
    }

    // Reasoning text is logged but not sent back: most reasoning APIs reject it in history.
    const { reasoning_content, ...toSend } = msg;
    if (reasoning_content) onEvent({ type: "reasoning", text: reasoning_content });
    if (msg.content) onEvent({ type: "assistant_text", text: msg.content });
    session.messages.push(toSend);

    if (!msg.tool_calls?.length) {
      const verify = guards.beforeFinish();
      if (verify) { await notify(verify); continue; }
      finalText = msg.content ?? "";
      session.meta.status = "done";
      await session.save();
      onEvent({ type: "done", status: "done", finalText });
      return finalText;
    }

    const ran: { call: ToolCall; ok: boolean }[] = [];
    for (const call of msg.tool_calls) {
      const result = await executeTool(call, byName, ctx, onEvent);
      session.messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      await session.log({ type: "tool", name: call.function.name, args: result.args, ok: result.ok, ms: result.ms, output: result.output });
      ran.push({ call, ok: result.ok });
    }
    const loop = guards.afterTools(ran);
    if (loop) await notify(loop);
    await session.save();
  }

  session.meta.status = "max_turns";
  await session.save();
  onEvent({ type: "done", status: "max_turns", finalText });
  return finalText;
}

async function executeTool(
  call: ToolCall,
  byName: Map<string, Tool>,
  ctx: ToolContext,
  onEvent: (e: AgentEvent) => void,
): Promise<{ output: string; args: any; ok: boolean; ms: number }> {
  const tool = byName.get(call.function.name);
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { output: `error: arguments were not valid JSON: ${call.function.arguments.slice(0, 500)}`, args: call.function.arguments, ok: false, ms: 0 };
  }
  if (!tool) return { output: `error: unknown tool "${call.function.name}". Available: ${[...byName.keys()].join(", ")}`, args, ok: false, ms: 0 };

  onEvent({ type: "tool_start", name: tool.name, args });
  const t0 = Date.now();
  let output: string, ok = true;
  try {
    output = await tool.run(args, ctx);
    if (output.startsWith("error:") || output === "denied by user") ok = false;
  } catch (e: any) {
    output = `error: ${e?.message ?? String(e)}`;
    ok = false;
  }
  const ms = Date.now() - t0;
  onEvent({ type: "tool_end", name: tool.name, result: output, ms });
  return { output, args, ok, ms };
}

/**
 * Fallback for endpoints that don't parse tool calls server-side: some models
 * emit <tool_call>{"name":..., "arguments":{...}}</tool_call> in plain text.
 */
export function recoverTextToolCalls(
  msg: Extract<Message, { role: "assistant" }>,
  byName: Map<string, Tool>,
): Extract<Message, { role: "assistant" }> {
  const text = msg.content ?? "";
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const j = JSON.parse(m[1]);
      if (j?.name && byName.has(j.name)) {
        calls.push({
          id: `textcall_${Date.now()}_${calls.length}`,
          type: "function",
          function: { name: j.name, arguments: JSON.stringify(j.arguments ?? j.parameters ?? {}) },
        });
      }
    } catch { /* not JSON, ignore */ }
  }
  if (!calls.length) return msg;
  return { ...msg, content: text.replace(re, "").trim() || null, tool_calls: calls };
}
