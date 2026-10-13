import type { Config } from "../config.js";
import type { Session } from "../session.js";

export interface ToolContext {
  config: Config;
  session: Session;
  /** Ask the user to approve a side-effecting action. Resolves true if allowed. */
  approve: (summary: string) => Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Side-effecting tools go through ctx.approve unless autoApprove is set. */
  mutates?: boolean;
  run(args: any, ctx: ToolContext): Promise<string>;
}

/** Cap tool output so one noisy command can't blow the context window. */
export function truncate(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max * 0.7);
  const tail = s.slice(-max * 0.3);
  return `${head}\n\n[... ${s.length - max} chars truncated ...]\n\n${tail}`;
}
