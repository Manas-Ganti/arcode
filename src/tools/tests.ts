import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./types.js";
import { runCommand } from "./shell.js";

/**
 * The project's test command: ARCODE_TEST_CMD, else detected from marker files.
 * `appendTarget` says how a selector (file, test id, filter) is added to it.
 */
export function detectTestCommand(workdir: string, override?: string): { cmd: string; appendTarget: (t: string) => string } | undefined {
  const has = (f: string) => existsSync(join(workdir, f));
  const plain = (cmd: string) => ({ cmd, appendTarget: (t: string) => `${cmd} ${t}` });
  if (override) return plain(override);
  if (has("package.json")) {
    const test = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")).scripts?.test as string | undefined;
    if (test && !test.includes("no test specified")) return { cmd: "npm test --silent", appendTarget: (t) => `npm test --silent -- ${t}` };
  }
  const pyTests = has("tests") || has("test") || readdirSync(workdir).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
  if (has("pytest.ini") || has("conftest.py") || (has("pyproject.toml") && readFileSync(join(workdir, "pyproject.toml"), "utf8").includes("[tool.pytest")) || pyTests) {
    return plain("python3 -m pytest -q -p no:cacheprovider");
  }
  if (has("go.mod")) return { cmd: "go test ./...", appendTarget: (t) => `go test ${t}` };
  if (has("Cargo.toml")) return plain("cargo test");
  return undefined;
}

/** Best-effort pass/fail counts from pytest, jest/vitest, cargo, or go output. */
export function parseTestCounts(out: string): { passed: number; failed: number } | undefined {
  const num = (re: RegExp) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  // pytest: "3 failed, 5 passed, 1 error in 0.12s" (last summary line wins)
  const py = out.split("\n").reverse().find((l) => / in [\d.]+s\b/.test(l) && /\d+ (passed|failed|errors?)\b/.test(l));
  if (py) {
    const n = (w: string) => { const m = py.match(new RegExp(`(\\d+) ${w}`)); return m ? Number(m[1]) : 0; };
    return { passed: n("passed"), failed: n("failed") + n("errors?") };
  }
  if (/^Tests:\s/m.test(out)) return { passed: num(/^Tests:.*?(\d+) passed/m), failed: num(/^Tests:.*?(\d+) failed/m) };
  if (/test result: /.test(out)) {
    let passed = 0, failed = 0;
    for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { passed += Number(m[1]); failed += Number(m[2]); }
    return { passed, failed };
  }
  const goOk = out.match(/^ok\s/gm)?.length ?? 0, goFail = out.match(/^FAIL\s/gm)?.length ?? 0;
  if (goOk + goFail) return { passed: goOk, failed: goFail }; // go reports per package
  return undefined;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const runTestsTool: Tool = {
  name: "run_tests",
  description:
    "Run the project's tests (auto-detected: npm test, pytest, go test, cargo test; or ARCODE_TEST_CMD). Returns a pass/fail summary and the tail of the output. " +
    "Pass `target` to run a subset (a test file, test id like tests/test_x.py::test_y, or a name filter). Run this after every change and before you finish.",
  mutates: true, // executes project code
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Optional test file, test id, or filter" },
      timeout_s: { type: "integer", description: "Timeout in seconds (default 300, max 900)", minimum: 1, maximum: 900 },
    },
  },
  async run({ target, timeout_s = 300 }, ctx) {
    const det = detectTestCommand(ctx.config.workdir, ctx.config.testCmd);
    if (!det) return "error: no test command detected (no package.json test script, pytest files, go.mod, or Cargo.toml). Set ARCODE_TEST_CMD, or run tests with bash.";
    const cmd = target ? det.appendTarget(shellQuote(String(target))) : det.cmd;
    if (!(await ctx.approve(`run tests: ${cmd}`))) return "denied by user";
    const r = await runCommand(cmd, ctx.config.workdir, Math.min(timeout_s, 900) * 1000);
    const counts = parseTestCounts(r.out);
    const verdict = r.timedOut ? `TIMED OUT after ${Math.min(timeout_s, 900)}s` : r.code === 0 ? "PASSED" : `FAILED (exit code ${r.code})`;
    const tally = counts ? ` · ${counts.passed} passed, ${counts.failed} failed` : "";
    // Failures and the summary are at the end of test output, so keep the tail.
    const out = r.out.trim();
    const shown = out.length > 12_000 ? `[... ${out.length - 12_000} earlier chars omitted ...]\n${out.slice(-12_000)}` : out;
    return `command: ${cmd}\nresult: ${verdict}${tally}\n\n${shown}`;
  },
};
