import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Model used for context compaction summaries (can be cheaper/faster). */
  summaryModel: string;
  /** Approximate token budget before compaction kicks in. 0 = derive from the model (see models.ts). */
  contextBudget: number;
  /** Extra JSON merged into every chat request (ARCODE_EXTRA_BODY), e.g. reasoning_effort. */
  extraBody: Record<string, unknown>;
  maxTurns: number;
  /** Auto-approve shell commands and file writes (headless / eval runs). */
  autoApprove: boolean;
  workdir: string;
  /** Where sessions + trajectories are stored. */
  dataDir: string;
  search: {
    provider: "brave" | "tavily" | "searxng" | "none";
    apiKey?: string;
    url?: string; // searxng base url
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const provider = (env.ARCODE_SEARCH_PROVIDER ??
    (env.BRAVE_API_KEY ? "brave" : env.TAVILY_API_KEY ? "tavily" : env.SEARXNG_URL ? "searxng" : "none")) as Config["search"]["provider"];

  const cfg: Config = {
    baseUrl: env.ARC_BASE_URL ?? "https://llm-api.arc.vt.edu/api/v1",
    apiKey: env.ARC_API_KEY ?? env.VTARC_API_KEY ?? "",
    model: env.ARCODE_MODEL ?? "",
    summaryModel: env.ARCODE_SUMMARY_MODEL ?? env.ARCODE_MODEL ?? "",
    contextBudget: Number(env.ARCODE_CONTEXT_BUDGET ?? 0),
    extraBody: parseExtraBody(env.ARCODE_EXTRA_BODY),
    maxTurns: Number(env.ARCODE_MAX_TURNS ?? 60),
    autoApprove: env.ARCODE_YES === "1",
    workdir: process.cwd(),
    dataDir: env.ARCODE_HOME ?? join(homedir(), ".arcode"),
    search: {
      provider,
      apiKey: provider === "brave" ? env.BRAVE_API_KEY : provider === "tavily" ? env.TAVILY_API_KEY : undefined,
      url: env.SEARXNG_URL,
    },
    ...overrides,
  };
  if (!cfg.summaryModel) cfg.summaryModel = cfg.model;
  return cfg;
}

/**
 * Load `$ARCODE_HOME/.env` (default ~/.arcode/.env) so the API key needn't live
 * in a shell profile. Real env vars win. Deliberately not the workdir's .env:
 * that belongs to the repo being edited, not to arcode.
 */
export function loadEnvFile(): void {
  const file = join(process.env.ARCODE_HOME ?? join(homedir(), ".arcode"), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("ARCODE_EXTRA_BODY must be a JSON object");
  return v as Record<string, unknown>;
}
