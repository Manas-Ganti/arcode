/**
 * Per-model knowledge: context window and extra request params, matched by id
 * prefix so ARC's thinking-budget variants (`-thinking-low`, `-thinking-max`, …)
 * share an entry.
 *
 * Measured on VT ARC (2026-10-13): the gateway applies variant ids itself
 * (gpt-oss-120b-thinking-high reasons ~8x longer than -thinking-low), so no
 * params are sent by default; sending `reasoning_effort` would override the
 * variant. To force thinking settings, use ARCODE_EXTRA_BODY, e.g.
 *   ARCODE_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false}}'
 * which turns thinking off for DeepSeek (GLM-5.3 ignores it).
 *
 * Context windows are not exposed by /models and the proxy clamps oversized
 * requests silently; the values below are from the call-centre entry and
 * unverified for the current model versions.
 */

export interface ModelSpec {
  contextWindow: number;
  /** Merged into every chat request body for this model. */
  params?: Record<string, unknown>;
}

const RULES: [RegExp, ModelSpec][] = [
  [/^deepseek-v4/i, { contextWindow: 512_000 }],
  [/^glm-/i, { contextWindow: 128_000 }],
  [/^gpt-oss-/i, { contextWindow: 128_000 }],
];

const FALLBACK: ModelSpec = { contextWindow: 128_000 };

export function modelSpec(id: string): ModelSpec & { known: boolean } {
  const hit = RULES.find(([re]) => re.test(id));
  return hit ? { ...hit[1], known: true } : { ...FALLBACK, known: false };
}

/** Compaction threshold: leave headroom for the reply and the char-based estimate's error. */
export const defaultContextBudget = (id: string) => Math.floor(modelSpec(id).contextWindow * 0.75);

/** Picker input → model id: a 1-based list number or an exact id (case-insensitive). */
export function resolveModel(ans: string, models: string[]): string | undefined {
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= models.length) return models[n - 1];
  return models.find((m) => m.toLowerCase() === ans.toLowerCase());
}
