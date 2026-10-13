/**
 * Import the Python exercises of Aider's polyglot benchmark as arcode eval tasks.
 *   git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark <dir>
 *   npx tsx scripts/import-polyglot.ts <dir>
 *
 * Writes evals/tasks/poly-<exercise>/ per exercise:
 *   repo/      the stub(s) plus the test file(s): unlike Aider's harness, the
 *              agent sees the tests from the start (it is meant to run them),
 *              so scores are not comparable with Aider's leaderboard
 *   solution/  .meta/example.py under the stub's name
 * Grading reruns the original test files (restored as protected paths).
 * Exercise content © Exercism (MIT); see evals/tasks/NOTICE.md.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const src = process.argv[2];
if (!src) {
  console.error("usage: npx tsx scripts/import-polyglot.ts <polyglot-benchmark checkout>");
  process.exit(1);
}
const practice = join(src, "python", "exercises", "practice");
const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "evals", "tasks");
const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

let n = 0;
for (const name of (await readdir(practice)).sort()) {
  const ex = join(practice, name);
  const cfg = JSON.parse(await readFile(join(ex, ".meta", "config.json"), "utf8")).files as { solution: string[]; test: string[]; example: string[] };
  if (cfg.solution.length !== 1 || cfg.example.length !== 1) {
    console.warn(`skip ${name}: expected one solution and one example file`);
    continue;
  }
  const docs = [join(ex, ".docs", "instructions.md"), join(ex, ".docs", "instructions.append.md")].filter((f) => existsSync(f));
  const instructions = (await Promise.all(docs.map((f) => readFile(f, "utf8")))).join("\n\n").trim();
  const stub = cfg.solution[0];
  const tests = cfg.test.filter((t) => t.endsWith("_test.py"));

  const dir = join(out, `poly-${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "repo"), { recursive: true });
  await mkdir(join(dir, "solution"), { recursive: true });
  for (const f of [...cfg.solution, ...cfg.test]) await cp(join(ex, f), join(dir, "repo", f));
  await cp(join(ex, cfg.example[0]), join(dir, "solution", stub));

  const prompt = `${instructions}

---
Implement this in \`${stub}\`. The tests are in ${tests.map((t) => `\`${t}\``).join(", ")}; make them pass, and do not modify them. Keep the names of existing functions and classes, since the tests import them. Use only the Python standard library.`;
  await writeFile(join(dir, "task.json"), JSON.stringify({
    id: `poly-${name}`,
    prompt,
    test_cmd: `python3 -m pytest -q -p no:cacheprovider ${tests.join(" ")}`,
    max_turns: 30,
    timeout_s: 180,
    tags: ["python", "exercism", "polyglot"],
    source: { repo: "https://github.com/Aider-AI/polyglot-benchmark", commit, path: `python/exercises/practice/${name}` },
  }, null, 2) + "\n");
  n++;
}
console.log(`imported ${n} exercises from ${basename(src)}@${commit.slice(0, 7)} → ${out}`);
