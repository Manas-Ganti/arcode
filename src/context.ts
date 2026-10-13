import type { LLM, Message } from "./llm.js";
import type { Session } from "./session.js";

/** Rough token estimate (~3.5 chars/token for code-heavy text). Good enough for budgeting. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) chars += c.function.arguments.length + c.function.name.length;
  }
  return Math.ceil(chars / 3.5);
}

/**
 * Compaction: keep [system, first user task], summarize the middle, keep the
 * most recent turns verbatim. The cut point is moved so a tool result is
 * never separated from the assistant message that called it (APIs reject that).
 */
export async function compact(opts: {
  llm: LLM;
  model: string;
  session: Session;
  keepRecent?: number;
}): Promise<boolean> {
  const { llm, model, session } = opts;
  const msgs = session.messages;
  const keepRecent = opts.keepRecent ?? 10;
  const head = 2; // system + original user task
  if (msgs.length <= head + keepRecent + 2) return false;

  let cut = msgs.length - keepRecent;
  // Don't start the kept tail on a tool message; walk back to its assistant call.
  while (cut > head && msgs[cut].role === "tool") cut--;
  if (cut <= head) return false;

  const middle = msgs.slice(head, cut);
  const transcript = middle
    .map((m) => {
      if (m.role === "assistant") {
        const calls = m.tool_calls?.map((c) => `  -> ${c.function.name}(${c.function.arguments.slice(0, 300)})`).join("\n") ?? "";
        return `ASSISTANT: ${m.content ?? ""}\n${calls}`;
      }
      if (m.role === "tool") return `TOOL RESULT: ${m.content.slice(0, 1500)}`;
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join("\n\n");

  const res = await llm.chat({
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You compress coding-agent transcripts. Produce a dense summary another agent can continue from: what was done, files touched and how, commands that worked or failed (with key error text), decisions made, and what remains. Keep exact file paths, function names, and error messages. No preamble.",
      },
      { role: "user", content: `${session.stateBlock()}\n\nTranscript to compress:\n\n${transcript}` },
    ],
  });

  const summary = res.message.content ?? "(summary unavailable)";
  session.messages = [
    ...msgs.slice(0, head),
    { role: "user", content: `<earlier_work_summary>\n${summary}\n</earlier_work_summary>\n\n${session.stateBlock()}\n\nContinue the task from here.` },
    { role: "assistant", content: "Understood. Continuing from the summary and current task state." },
    ...msgs.slice(cut),
  ];
  session.meta.compactions++;
  await session.log({ type: "compaction", removed_messages: middle.length, summary });
  return true;
}
