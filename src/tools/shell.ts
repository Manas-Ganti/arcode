import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import { truncate } from "./types.js";

export interface CommandResult { code: number | null; out: string; timedOut: boolean }

/** arcode's own credentials: never passed to commands the model runs, so `env` can't leak them into trajectories. */
const ARCODE_SECRETS = ["ARC_API_KEY", "VTARC_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY"];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", PAGER: "cat" };
  for (const k of ARCODE_SECRETS) delete env[k];
  return env;
}

/**
 * Run a command with `bash -c` in `cwd`, merging stdout/stderr, killed after `timeoutMs`. Never rejects.
 * Not `-l`: on macOS a login shell rebuilds PATH with system dirs first (python3 → /usr/bin/python3),
 * hiding the conda/nvm tools of the terminal arcode was started from.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", command], { cwd, env: childEnv() });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: `failed to start: ${e.message}`, timedOut: false });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

/**
 * Runs a shell command in the workspace. Not a sandbox: for untrusted tasks
 * (benchmarks), run arcode itself inside a container. See docs/ARCHITECTURE.md.
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace root (bash -c, same environment as the terminal arcode was started from). Use for builds, git, package managers, running programs. Non-interactive only; output is truncated. Prefer run_tests for tests.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_s: { type: "integer", description: "Timeout in seconds (default 120, max 900)", minimum: 1, maximum: 900 },
    },
    required: ["command"],
  },
  async run({ command, timeout_s = 120 }, ctx) {
    if (!(await ctx.approve(`run: ${command}`))) return "denied by user";
    const timeout = Math.min(timeout_s, 900) * 1000;
    const r = await runCommand(command, ctx.config.workdir, timeout);
    if (r.code === null && !r.timedOut) return r.out;
    const status = r.timedOut ? `timed out after ${timeout / 1000}s` : `exit code ${r.code}`;
    return truncate(`${r.out}\n[${status}]`.trim());
  },
};
