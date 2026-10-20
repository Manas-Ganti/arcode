/**
 * Offline test of `arcode setup`: .env merging, key verification against a fake /models,
 * file mode 600, the key on stdin, a rejected key saving nothing, and --show masking the key.
 *   npm run test:mock
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { setupMain, upsertEnv } from "../src/setup.js";

const checks: [string, boolean][] = [];

// ---- Unit: upsertEnv keeps everything it doesn't own.
const before = "# my settings\nexport ARC_API_KEY=old\nBRAVE_API_KEY=b\nARC_API_KEY=dup\nARCODE_MODEL=gone\n";
const after = upsertEnv(before, { ARC_API_KEY: "sk-new", ARC_BASE_URL: "http://h/v1", ARCODE_MODEL: undefined });
checks.push(["upsert: replaces in place, drops duplicates, keeps comments", after === "# my settings\nARC_API_KEY=sk-new\nBRAVE_API_KEY=b\nARC_BASE_URL=http://h/v1\n"]);
checks.push(["upsert: quotes values that need it", parseEnv(upsertEnv("", { K: "a b#c" })).K === "a b#c"]);

// ---- Fake endpoint: /models answers only to the right key.
const server = createServer((req, res) => {
  const ok = req.headers.authorization === "Bearer sk-good-key-123456";
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(ok ? JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "text-embed-1" }] }) : '{"error":"bad key"}');
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

const home = await mkdtemp(join(tmpdir(), "arcode-setup-"));
process.env.ARCODE_HOME = home;
const file = join(home, ".env");
await writeFile(file, "BRAVE_API_KEY=brave\n", { mode: 0o644 });

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try { return await f(); } finally { console.log = log; }
};

// ---- Non-interactive: flags.
const written = await quiet(() => setupMain(["--base-url", url, "--api-key", "sk-good-key-123456", "--model", "MODEL-B"]));
const env = parseEnv(await readFile(file, "utf8"));
checks.push(["flags: key, endpoint and model saved", env.ARC_API_KEY === "sk-good-key-123456" && env.ARC_BASE_URL === url && env.ARCODE_MODEL === "model-b"]);
checks.push(["flags: model id resolved case-insensitively and returned", written.ARCODE_MODEL === "model-b"]);
checks.push(["flags: unrelated settings kept", env.BRAVE_API_KEY === "brave"]);
checks.push(["file mode tightened to 600", ((await stat(file)).mode & 0o777) === 0o600]);

// ---- A rejected key or unknown model saves nothing.
const snapshot = await readFile(file, "utf8");
const rejected = await setupMain(["--base-url", url, "--api-key", "sk-wrong"]).then(() => "", (e: Error) => e.message);
checks.push(["bad key: error names the rejection", rejected.includes("rejected the key (401)")]);
const badModel = await setupMain(["--base-url", url, "--api-key", "sk-good-key-123456", "--model", "nope"]).then(() => "", (e: Error) => e.message);
checks.push(["unknown model: refused", badModel.includes("not a model")]);
checks.push(["failures leave the file untouched", (await readFile(file, "utf8")) === snapshot]);
await quiet(() => setupMain(["--provider", "local", "--base-url", "http://127.0.0.1:1/v1", "--no-verify"]));
const local = parseEnv(await readFile(file, "utf8"));
checks.push(["local without a key: placeholder saved, stale model removed", local.ARC_API_KEY === "none" && local.ARCODE_MODEL === undefined]);

// ---- The CLI: key on stdin, then --show masks it.
// Async spawn: the fake endpoint lives in this process, so a blocking spawn would deadlock.
const cli = (args: string[], input = "") =>
  new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "setup", ...args], { env: { ...process.env, ARC_API_KEY: "", VTARC_API_KEY: "" } });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("close", (status) => resolve({ status, stdout }));
    p.stdin.end(input);
  });
const piped = await cli(["--base-url", url], "sk-good-key-123456\n");
checks.push(["cli: key read from stdin", piped.status === 0 && parseEnv(await readFile(file, "utf8")).ARC_API_KEY === "sk-good-key-123456"]);
const shown = await cli(["--show"]);
checks.push(["cli: --show masks the key", shown.status === 0 && shown.stdout.includes("sk-…3456") && !shown.stdout.includes("good-key")]);

server.close();

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
