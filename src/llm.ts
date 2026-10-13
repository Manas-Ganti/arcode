/**
 * Thin OpenAI-compatible chat client. Deliberately no SDK: we need to see and
 * keep non-standard fields (e.g. `reasoning_content` from DeepSeek/GLM-style
 * reasoning models) for trajectory logging.
 */

import { modelSpec } from "./models.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs: number;
}

export class LLMError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

export class LLM {
  /** `extraBody` is merged into every chat request, after the model's own params from models.ts. */
  constructor(private baseUrl: string, private apiKey: string, private extraBody: Record<string, unknown> = {}) {}

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new LLMError(`GET /models failed: ${res.status}`, res.status, await res.text());
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  async chat(opts: {
    model: string;
    messages: Message[];
    tools?: ToolSpec[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      ...modelSpec(opts.model).params,
      ...this.extraBody,
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }

    // ARC rate limits are ~60 req/min, so back off on 429 and transient 5xx.
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      } catch (e) {
        if (attempt >= maxAttempts || opts.signal?.aborted) throw e;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text();
        if (attempt >= maxAttempts) throw new LLMError(`chat failed after ${attempt} attempts: ${res.status}`, res.status, text);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (!res.ok) throw new LLMError(`chat failed: ${res.status}`, res.status, await res.text());

      const json = (await res.json()) as any;
      const choice = json.choices?.[0];
      if (!choice) throw new LLMError("no choices in response", res.status, JSON.stringify(json).slice(0, 2000));
      const m = choice.message ?? {};
      // DeepSeek-style servers use `reasoning_content`; vLLM-style (incl. VT ARC) use `reasoning`.
      const reasoning = m.reasoning_content || m.reasoning;
      const message: ChatResult["message"] = {
        role: "assistant",
        content: m.content ?? null,
        ...(m.tool_calls?.length ? { tool_calls: normalizeToolCalls(m.tool_calls) } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      };
      return { message, finishReason: choice.finish_reason ?? "unknown", usage: json.usage, latencyMs: Date.now() - t0 };
    }
  }
}

function normalizeToolCalls(calls: any[]): ToolCall[] {
  return calls.map((c, i) => ({
    id: c.id || `call_${Date.now()}_${i}`,
    type: "function",
    function: {
      name: c.function?.name ?? "",
      arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
    },
  }));
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
