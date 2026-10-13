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
  /** 1 unless the request was retried (429/5xx, network error, or stall). */
  attempts: number;
}

/** One streamed fragment of the assistant message. */
export type Delta = { content: string } | { reasoning: string };

export class LLMError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
  }
}

export class LLM {
  /**
   * `extraBody` is merged into every chat request, after the model's own params from models.ts.
   * `timeoutMs`: a streamed request is aborted after this long with no data; a buffered one after this long in total.
   */
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private extraBody: Record<string, unknown> = {},
    private timeoutMs = 180_000,
  ) {}

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
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
    /** If set, the request streams (SSE) and fragments arrive here as they are generated. */
    onDelta?: (d: Delta) => void;
    /** Called before each retry, so callers can log why requests are being repeated. */
    onRetry?: (r: { attempt: number; reason: "stalled" | "network" | "http"; status?: number; elapsedMs: number }) => void;
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
    if (opts.onDelta) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    // ARC rate limits are ~60 req/min, so back off on 429 and transient 5xx. A stalled request
    // (no data for timeoutMs: dead connection, stuck upstream) is aborted and retried the same way.
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const forward = () => ctrl.abort();
      opts.signal?.addEventListener("abort", forward, { once: true });
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; ctrl.abort(); }, this.timeoutMs);
      };
      arm();
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          const text = await res.text();
          clearTimeout(timer);
          if (attempt >= maxAttempts) throw new LLMError(`chat failed after ${attempt} attempts: ${res.status}`, res.status, text);
          opts.onRetry?.({ attempt, reason: "http", status: res.status, elapsedMs: Date.now() - t0 });
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
          continue;
        }
        if (!res.ok) throw new LLMError(`chat failed: ${res.status}`, res.status, await res.text());

        let m: any, finishReason: string | undefined, usage: ChatResult["usage"];
        if (opts.onDelta) {
          ({ m, finishReason, usage } = await readStream(res, opts.onDelta, arm));
        } else {
          const json = (await res.json()) as any;
          const choice = json.choices?.[0];
          if (!choice) throw new LLMError("no choices in response", res.status, JSON.stringify(json).slice(0, 2000));
          m = choice.message ?? {};
          finishReason = choice.finish_reason;
          usage = json.usage;
        }
        // DeepSeek-style servers use `reasoning_content`; vLLM-style (incl. VT ARC) use `reasoning`.
        const reasoning = m.reasoning_content || m.reasoning;
        const message: ChatResult["message"] = {
          role: "assistant",
          content: m.content ?? null,
          ...(m.tool_calls?.length ? { tool_calls: normalizeToolCalls(m.tool_calls) } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        };
        return { message, finishReason: finishReason ?? "unknown", usage, latencyMs: Date.now() - t0, attempts: attempt };
      } catch (e) {
        // HTTP errors and caller aborts are final; network errors and stalls are retried.
        if (e instanceof LLMError || (opts.signal?.aborted && !stalled)) throw e;
        clearTimeout(timer);
        if (attempt >= maxAttempts) {
          throw stalled ? new LLMError(`no data from the endpoint for ${this.timeoutMs / 1000}s (stalled), ${attempt} attempts`) : e;
        }
        opts.onRetry?.({ attempt, reason: stalled ? "stalled" : "network", elapsedMs: Date.now() - t0 });
        await sleep(backoff(attempt));
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", forward);
      }
    }
  }
}

/**
 * Assemble an SSE chat stream into the same shape as a non-streamed `message`.
 * Tool calls arrive as fragments keyed by `index`; their arguments are concatenated.
 */
async function readStream(res: Response, onDelta: (d: Delta) => void, onActivity: () => void) {
  const m = { content: "", reasoning: "", tool_calls: [] as any[] };
  let finishReason: string | undefined;
  let usage: ChatResult["usage"];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.error) throw new LLMError("stream error", res.status, JSON.stringify(j.error).slice(0, 2000));
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const d = ch.delta ?? {};
      const r = d.reasoning_content || d.reasoning;
      if (r) { m.reasoning += r; onDelta({ reasoning: r }); }
      if (d.content) { m.content += d.content; onDelta({ content: d.content }); }
      for (const tc of d.tool_calls ?? []) {
        const slot = (m.tool_calls[tc.index ?? 0] ??= { id: "", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name && !slot.function.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  return {
    m: { content: m.content || null, reasoning: m.reasoning, tool_calls: m.tool_calls.filter(Boolean) },
    finishReason,
    usage,
  };
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
