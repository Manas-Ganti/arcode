/**
 * Day-one check: does the ARC endpoint give us what the harness needs?
 *   npm run probe                 # probes every GLM / DeepSeek model listed
 *   npm run probe -- <model-id>   # probe specific models
 *
 * For each model it checks:
 *   1. plain chat works
 *   2. native tool calling returns structured `tool_calls`
 *   3. the model accepts a tool result and continues (round trip)
 *   4. whether reasoning is exposed (`reasoning_content` or ARC's `reasoning`; matters for trajectory logging)
 *   5. parallel tool calls in one turn
 */
import { LLM, type Message, type ToolSpec } from "../src/llm.js";
import { loadConfig, loadEnvFile } from "../src/config.js";

loadEnvFile();
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("Set ARC_API_KEY first (llm.arc.vt.edu > Settings > Account > API keys).");
  process.exit(1);
}
const llm = new LLM(cfg.baseUrl, cfg.apiKey, cfg.extraBody);

const weatherTool: ToolSpec = {
  type: "function",
  function: {
    name: "get_file_size",
    description: "Return the size in bytes of a file in the repo.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

type Row = { model: string; chat: string; tools: string; roundtrip: string; parallel: string; reasoning: string; latency: string };

async function probe(model: string): Promise<Row> {
  const row: Row = { model, chat: "-", tools: "-", roundtrip: "-", parallel: "-", reasoning: "no", latency: "-" };
  try {
    const r = await llm.chat({ model, messages: [{ role: "user", content: "Reply with exactly: pong" }], maxTokens: 2000 });
    row.chat = /pong/i.test(r.message.content ?? "") ? "ok" : `odd: ${(r.message.content ?? "").slice(0, 40)}`;
    row.latency = `${r.latencyMs}ms`;
    if (r.message.reasoning_content) row.reasoning = "yes";
  } catch (e: any) {
    row.chat = `FAIL ${e.status ?? ""} ${(e.body ?? e.message).slice(0, 80)}`;
    return row;
  }

  const ask: Message[] = [
    { role: "system", content: "Use tools when helpful." },
    { role: "user", content: "How many bytes is README.md? Use the tool." },
  ];
  try {
    const r = await llm.chat({ model, messages: ask, tools: [weatherTool], maxTokens: 2000 });
    const call = r.message.tool_calls?.[0];
    if (!call) {
      const t = r.message.content ?? "";
      row.tools = /<tool_call>|"name"\s*:\s*"get_file_size"/.test(t) ? "TEXT ONLY (needs parser fallback)" : "no call";
      return row;
    }
    JSON.parse(call.function.arguments);
    row.tools = `ok (${call.function.name})`;

    const r2 = await llm.chat({
      model,
      maxTokens: 2000,
      tools: [weatherTool],
      messages: [...ask, { role: "assistant", content: r.message.content, tool_calls: r.message.tool_calls }, { role: "tool", tool_call_id: call.id, content: "1234" }],
    });
    row.roundtrip = /1,?234/.test(r2.message.content ?? "") ? "ok" : `odd: ${(r2.message.content ?? "").slice(0, 40)}`;
  } catch (e: any) {
    row.tools = row.tools === "-" ? `FAIL ${e.status ?? ""} ${(e.body ?? e.message).slice(0, 80)}` : row.tools;
    row.roundtrip = `FAIL ${e.status ?? ""} ${(e.body ?? e.message).slice(0, 80)}`;
    return row;
  }

  try {
    const r = await llm.chat({
      model,
      maxTokens: 2000,
      tools: [weatherTool],
      messages: [{ role: "user", content: "Get the sizes of README.md and package.json. Call the tool for both at once." }],
    });
    row.parallel = `${r.message.tool_calls?.length ?? 0} calls`;
  } catch (e: any) {
    row.parallel = `FAIL ${e.status ?? ""}`;
  }
  return row;
}

const all = await llm.listModels();
console.log(`Endpoint ${cfg.baseUrl} lists ${all.length} models:\n  ${all.join("\n  ")}\n`);
const targets = process.argv.slice(2).length ? process.argv.slice(2) : all.filter((m) => /glm|deepseek/i.test(m));
if (!targets.length) {
  console.log("No GLM/DeepSeek models matched; pass model ids explicitly.");
  process.exit(0);
}
const rows: Row[] = [];
for (const m of targets) {
  process.stdout.write(`probing ${m} ... `);
  const row = await probe(m);
  rows.push(row);
  console.log("done");
}
console.table(rows);
console.log(`
How to read this:
  tools = ok, roundtrip = ok   -> native tool calling works; arcode runs as-is.
  tools = TEXT ONLY            -> server isn't parsing tool calls; arcode's <tool_call> text fallback
                                  handles the common format, but check the raw output format.
  reasoning = yes              -> reasoning_content is exposed and will be logged in trajectories.
  parallel = 2 calls           -> model batches independent calls (faster runs).`);
