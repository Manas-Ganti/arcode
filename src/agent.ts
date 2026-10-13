import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import type { Config } from "./config.js";
import { LLM, type Message, type ToolCall } from "./llm.js";
import { Session } from "./session.js";
import { ALL_TOOLS, toSpecs, type Tool, type ToolContext } from "./tools/index.js";
import { compact, estimateTokens } from "./context.js";

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
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
- After changes, verify: run the tests, type-checker, or the program with bash. Fix what fails.
- Use web_search + web_fetch when unsure about a library API, an error, or anything version-specific.
- Save durable facts (decisions, key paths, working commands) with note; they survive context compaction.
- Keep messages short. When the task is complete, reply with a brief summary of what changed and how you verified it, and make no further tool calls.${project}`;
}

export async function runAgent(userInput: string, opts: AgentOptions): Promise<string> {
  const { config, session, approve, onEvent = () => {} } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = toSpecs(tools);
  const llm = new LLM(config.baseUrl, config.apiKey);
  const ctx: ToolContext = {
    config,
    session,
    approve: config.autoApprove ? async () => true : approve,
  };

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: await buildSystemPrompt(config, tools) });
  }
  session.messages.push({ role: "user", content: userInput });
  await session.log({ type: "user", content: userInput });
  session.meta.status = "running";

  let finalText = "";
  for (let turn = 0; turn < config.maxTurns; turn++) {
    if (estimateTokens(session.messages) > config.contextBudget) {
      if (await compact({ llm, model: config.summaryModel, session })) onEvent({ type: "compaction" });
    }

    const res = await llm.chat({ model: config.model, messages: session.messages, tools: specs });
    let msg = res.message;
    if (!msg.tool_calls?.length && msg.content) msg = recoverTextToolCalls(msg, byName);

    session.meta.turns++;
    session.meta.usage.prompt += res.usage?.prompt_tokens ?? 0;
    session.meta.usage.completion += res.usage?.completion_tokens ?? 0;
    await session.log({
      type: "llm_call",
      model: config.model,
      finish_reason: res.finishReason,
      usage: res.usage,
      latency_ms: res.latencyMs,
      context_tokens_est: estimateTokens(session.messages),
      message: msg,
    });

    // Reasoning text is logged but not sent back: most reasoning APIs reject it in history.
    const { reasoning_content, ...toSend } = msg;
    if (reasoning_content) onEvent({ type: "reasoning", text: reasoning_content });
    if (msg.content) onEvent({ type: "assistant_text", text: msg.content });
    session.messages.push(toSend);

    if (!msg.tool_calls?.length) {
      finalText = msg.content ?? "";
      session.meta.status = "done";
      await session.save();
      onEvent({ type: "done", status: "done", finalText });
      return finalText;
    }

    for (const call of msg.tool_calls) {
      const result = await executeTool(call, byName, ctx, onEvent);
      session.messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      await session.log({ type: "tool", name: call.function.name, args: result.args, ok: result.ok, ms: result.ms, output: result.output });
    }
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
