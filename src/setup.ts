/**
 * `arcode setup`: pick a provider, enter its API key, check it against /models, and save it to
 * $ARCODE_HOME/.env (default ~/.arcode/.env, mode 600). Re-run any time to switch provider or key.
 *
 * Non-interactive (scripts, clusters):
 *   arcode setup --provider openai --api-key sk-...
 *   echo "$KEY" | arcode setup --base-url https://host/v1      (key on stdin stays out of shell history)
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import { LLM } from "./llm.js";
import { resolveModel } from "./models.js";
import { pickFromList } from "./picker.js";

export interface Provider { id: string; name: string; baseUrl: string; keyUrl?: string }

export const PROVIDERS: Provider[] = [
  { id: "arc", name: "VT ARC (GLM, DeepSeek, gpt-oss; free for VT accounts)", baseUrl: "https://llm-api.arc.vt.edu/api/v1", keyUrl: "https://llm.arc.vt.edu > profile > Settings > Account > API keys" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", name: "OpenRouter (many providers, one key)", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys" },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys" },
  { id: "local", name: "Local server (vLLM, Ollama, LM Studio, llama.cpp)", baseUrl: "http://localhost:8000/v1" },
  { id: "custom", name: "Other OpenAI-compatible endpoint", baseUrl: "" },
];

/** Written as the key for servers that don't check one (local vLLM/Ollama); arcode requires a non-empty key. */
const NO_KEY = "none";

export const SETUP_HELP = `arcode setup: choose a provider and save its API key to ~/.arcode/.env

  arcode setup                                   interactive
  arcode setup --provider <id> --api-key <key>   non-interactive (or pipe the key on stdin)
  arcode setup --show                            print the current settings (key masked)

  --provider <id>    ${PROVIDERS.map((p) => p.id).join(" | ")}
  --base-url <url>   any OpenAI-compatible /v1 endpoint (implies --provider custom)
  --api-key <key>    the key (prefer stdin: flags end up in shell history)
  --model <id>       default model (otherwise arcode shows a picker at startup)
  --no-verify        save without checking the key against the endpoint's /models`;

export const envPath = () => join(process.env.ARCODE_HOME ?? join(homedir(), ".arcode"), ".env");

/** Set each KEY=value line (undefined removes it), keeping every other line and comment as is. */
export function upsertEnv(text: string, values: Record<string, string | undefined>): string {
  let lines = text ? text.replace(/\n$/, "").split("\n") : [];
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^\\s*(export\\s+)?${k}\\s*=`);
    const at = lines.findIndex((l) => re.test(l));
    lines = lines.filter((l) => !re.test(l));
    if (v === undefined) continue;
    const line = `${k}=${/^[\w.\-/:+=@~,]*$/.test(v) ? v : v.includes('"') ? `'${v}'` : `"${v}"`}`;
    if (at < 0) lines.push(line);
    else lines.splice(at, 0, line);
  }
  return lines.join("\n") + "\n";
}

const mask = (key: string) => (key === NO_KEY ? "(none)" : key.length > 10 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "****");

const HEADER = `# arcode settings (written by \`arcode setup\`; edit freely, or re-run setup).
# Variables already set in your shell override this file. Other options: see README > Configuration.
`;

async function verify(baseUrl: string, key: string): Promise<{ models?: string[]; error?: string }> {
  try {
    return { models: (await new LLM(baseUrl, key, {}, 15_000).listModels()).filter((m) => !/embed/i.test(m)) };
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) return { error: `the endpoint rejected the key (${e.status})` };
    return { error: `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ""}` };
  }
}

/** Readline prompts, plus a masked one for the key (echo goes to a muted stream). */
function prompter() {
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: stdin, output: out, terminal: true });
  rl.on("SIGINT", () => { stdout.write("\n"); process.exit(130); });
  return {
    ask: async (q: string) => (await rl.question(q)).trim(),
    secret: async (q: string) => {
      stdout.write(q);
      muted = true;
      try { return (await rl.question("")).trim(); } finally { muted = false; stdout.write("\n"); }
    },
    close: () => rl.close(),
  };
}

/** Runs setup; resolves to the values written (empty if nothing changed). */
export async function setupMain(argv: string[]): Promise<Record<string, string | undefined>> {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (["show", "no-verify", "help"].includes(k)) a[k] = true;
    else if (["provider", "base-url", "api-key", "model"].includes(k) && argv[i + 1] !== undefined) a[k] = argv[++i];
    else throw new Error(`unknown setup argument: ${argv[i]}\n\n${SETUP_HELP}`);
  }
  if (a.help) { console.log(SETUP_HELP); return {}; }

  const file = envPath();
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const current = parseEnv(text);
  const curKey = current.ARC_API_KEY ?? current.VTARC_API_KEY;
  const curUrl = current.ARC_BASE_URL ?? PROVIDERS[0].baseUrl;
  if (a.show) {
    console.log(`${file}${text ? "" : " (missing: run arcode setup)"}\n  endpoint  ${curUrl}\n  key       ${curKey ? mask(curKey) : "(not set)"}\n  model     ${current.ARCODE_MODEL ?? "(picked at startup)"}`);
    return {};
  }

  const flagged = Boolean(a.provider || a["base-url"] || a["api-key"]);
  let baseUrl: string, key: string, model: string | undefined;
  let models: string[] | undefined;

  if (flagged || !stdin.isTTY) {
    const p = PROVIDERS.find((x) => x.id === (a.provider ?? (a["base-url"] ? "custom" : "arc")));
    if (!p) throw new Error(`unknown provider: ${a.provider} (one of ${PROVIDERS.map((x) => x.id).join(", ")})`);
    baseUrl = typeof a["base-url"] === "string" ? a["base-url"] : p.baseUrl;
    if (!baseUrl) throw new Error("--provider custom needs --base-url");
    if (typeof a["api-key"] === "string") key = a["api-key"];
    else if (!stdin.isTTY) { let s = ""; for await (const chunk of stdin) s += chunk; key = s.trim(); }
    else key = "";
    if (!key && p.id !== "local") throw new Error("no API key: pass --api-key or pipe it on stdin");
    key ||= NO_KEY;
    if (!a["no-verify"]) {
      const v = await verify(baseUrl, key);
      if (v.error) throw new Error(`could not verify the key against ${baseUrl}: ${v.error}\nNothing was saved. Fix it, or pass --no-verify.`);
      models = v.models;
    }
    model = typeof a.model === "string" ? a.model : undefined;
    if (model && models) model = resolveModel(model, models) ?? (() => { throw new Error(`not a model on ${baseUrl}: ${model}`); })();
  } else {
    const io = prompter();
    try {
      if (curKey) console.log(`Current: ${curUrl} · key ${mask(curKey)}\n`);
      const initial = Math.max(0, PROVIDERS.findIndex((p) => p.baseUrl === curUrl));
      const picked = await pickFromList("Which provider?", PROVIDERS.map((p) => `${p.name}${p.baseUrl ? `  \x1b[2m${p.baseUrl}\x1b[22m` : ""}`), initial);
      if (picked === undefined) { console.log("Cancelled; nothing changed."); return {}; }
      const p = PROVIDERS[picked];
      console.log(`Provider: ${p.name}`);
      baseUrl = p.baseUrl;
      if (p.id === "local" || p.id === "custom") {
        const def = p.id === "custom" && curUrl !== PROVIDERS[0].baseUrl ? curUrl : p.baseUrl;
        for (;;) {
          baseUrl = (await io.ask(`Base URL (ends in /v1)${def ? ` [${def}]` : ""}: `)) || def;
          if (/^https?:\/\/\S+$/.test(baseUrl)) break;
          console.log("  enter a URL such as https://host/v1 (Ollama: http://localhost:11434/v1)");
        }
      }
      const keep = curKey && baseUrl === curUrl ? curKey : undefined;
      if (p.keyUrl) console.log(`Get a key at ${p.keyUrl}`);
      for (;;) {
        const hint = keep ? ` (Enter keeps ${mask(keep)})` : p.id === "local" ? " (Enter if the server needs none)" : "";
        key = (await io.secret(`API key${hint}: `)) || keep || (p.id === "local" || p.id === "custom" ? NO_KEY : "");
        if (!key) { console.log("  a key is required for this provider"); continue; }
        stdout.write("Checking… ");
        const v = await verify(baseUrl, key);
        if (!v.error) { models = v.models; console.log(`ok, ${models?.length ?? 0} models available`); break; }
        console.log(`failed: ${v.error}`);
        const ans = (await io.ask("[r]etry the key, [s]ave anyway, or [q]uit? ")).toLowerCase();
        if (ans.startsWith("s")) break;
        if (!ans.startsWith("r")) { console.log("Nothing changed."); return {}; }
      }
      if (models?.length) {
        if (models.length <= 15) {
          const i = await pickFromList("Default model?", ["(choose each time arcode starts)", ...models], Math.max(0, models.indexOf(current.ARCODE_MODEL ?? "") + 1));
          model = i ? models[i - 1] : undefined;
        } else {
          console.log(`Some models: ${models.slice(0, 8).join(", ")}, … (\`arcode --models\` lists all)`);
          for (;;) {
            const ans = await io.ask("Default model id (Enter: choose each time arcode starts): ");
            model = ans ? resolveModel(ans, models) : undefined;
            if (!ans || model) break;
            console.log(`  not a model on this endpoint: ${ans}`);
          }
        }
      }
      if (model) console.log(`Default model: ${model}`);
    } finally {
      io.close();
    }
  }

  const values = { ARC_BASE_URL: baseUrl, ARC_API_KEY: key, ARCODE_MODEL: model };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, upsertEnv(text || HEADER, values), { mode: 0o600 });
  await chmod(file, 0o600); // an existing file keeps its old mode on write
  console.log(`Saved to ${file.replace(homedir(), "~")}. Start with: arcode`);
  // A variable set in the shell wins over the file; say so rather than leave a silent mismatch.
  for (const k of ["ARC_API_KEY", "VTARC_API_KEY", "ARC_BASE_URL", "ARCODE_MODEL"]) {
    const shell = process.env[k];
    if (shell !== undefined && shell !== current[k] && shell !== values[k as keyof typeof values]) console.log(`note: ${k} is also set in your shell and overrides the file; \`unset ${k}\` to use the saved value`);
  }
  return values;
}
