import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import { truncate } from "./types.js";

/**
 * Runs a shell command in the workspace. Not a sandbox: for untrusted tasks
 * (benchmarks), run arcode itself inside a container. See docs/ARCHITECTURE.md.
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace root (bash -lc). Use for builds, tests, git, package managers. Non-interactive only; output is truncated.",
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
    return new Promise((resolve) => {
      const p = spawn("bash", ["-lc", command], { cwd: ctx.config.workdir, env: { ...process.env, CI: "1", PAGER: "cat" } });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill("SIGKILL");
      }, timeout);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve(`failed to start: ${e.message}`);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        const status = timedOut ? `timed out after ${timeout / 1000}s` : `exit code ${code}`;
        resolve(truncate(`${out}\n[${status}]`.trim()));
      });
    });
  },
};
