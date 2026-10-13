import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Model used for context compaction summaries (can be cheaper/faster). */
  summaryModel: string;
  /** Approximate token budget before compaction kicks in. */
  contextBudget: number;
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
    apiKey: env.ARC_API_KEY ?? "",
    model: env.ARCODE_MODEL ?? "",
    summaryModel: env.ARCODE_SUMMARY_MODEL ?? env.ARCODE_MODEL ?? "",
    contextBudget: Number(env.ARCODE_CONTEXT_BUDGET ?? 100_000),
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
