import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "./types.js";
import { truncate } from "./types.js";

/** Resolve a path and refuse anything outside the working directory. */
export function safePath(p: string, ctx: ToolContext): string {
  const root = resolve(ctx.config.workdir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path outside workspace: ${p}`);
  return abs;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a text file. Returns numbered lines. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root" },
      offset: { type: "integer", description: "1-based line to start from", minimum: 1 },
      limit: { type: "integer", description: "Max lines to return (default 400)", minimum: 1 },
    },
    required: ["path"],
  },
  async run({ path, offset = 1, limit = 400 }, ctx) {
    const abs = safePath(path, ctx);
    const text = await readFile(abs, "utf8");
    const lines = text.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    ctx.session.markRead(abs);
    const body = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join("\n");
    const more = offset - 1 + limit < lines.length ? `\n[${lines.length - (offset - 1 + limit)} more lines; use offset]` : "";
    return truncate(body + more);
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create a new file or fully overwrite an existing one. Prefer edit_file for changes to existing files.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run({ path, content }, ctx) {
    const abs = safePath(path, ctx);
    const exists = await stat(abs).then(() => true, () => false);
    if (exists && !ctx.session.hasRead(abs)) {
      return `error: ${path} exists and has not been read this session. read_file it first, or use edit_file.`;
    }
    if (!(await ctx.approve(`write ${path} (${content.length} chars)`))) return "denied by user";
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    ctx.session.markRead(abs);
    return `wrote ${path}`;
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match exactly once (include surrounding lines to make it unique) unless replace_all is true. Read the file first.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run({ path, old_string, new_string, replace_all = false }, ctx) {
    const abs = safePath(path, ctx);
    if (!ctx.session.hasRead(abs)) return `error: read_file ${path} before editing it.`;
    const text = await readFile(abs, "utf8");
    const count = old_string ? text.split(old_string).length - 1 : 0;
    if (count === 0) return `error: old_string not found in ${path}. Re-read the file; whitespace must match exactly.`;
    if (count > 1 && !replace_all) return `error: old_string matches ${count} places in ${path}. Add surrounding context or set replace_all.`;
    if (!(await ctx.approve(`edit ${path} (${count} replacement${count > 1 ? "s" : ""})`))) return "denied by user";
    const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    await writeFile(abs, next);
    return `edited ${path} (${count} replacement${count > 1 ? "s" : ""})`;
  },
};

const IGNORE = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", ".arcode"]);

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List files under a directory (recursive up to depth). Skips .git, node_modules, build outputs.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory (default '.')" },
      depth: { type: "integer", description: "Max depth (default 2)", minimum: 1, maximum: 6 },
    },
  },
  async run({ path = ".", depth = 2 }, ctx) {
    const root = safePath(path, ctx);
    const out: string[] = [];
    async function walk(dir: string, d: number) {
      if (out.length > 1500) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const rel = relative(ctx.config.workdir, join(dir, e.name));
        out.push(e.isDirectory() ? rel + "/" : rel);
        if (e.isDirectory() && d < depth) await walk(join(dir, e.name), d + 1);
      }
    }
    await walk(root, 1);
    return truncate(out.join("\n") || "(empty)");
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents with a regex (ripgrep if installed, else grep -rn). Returns path:line:text.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "File or directory (default '.')" },
      glob: { type: "string", description: "Only files matching this glob, e.g. '*.ts'" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  async run({ pattern, path = ".", glob, ignore_case }, ctx) {
    const target = safePath(path, ctx);
    const rgArgs = ["-n", "--no-heading", "--max-count", "50", ...(ignore_case ? ["-i"] : []), ...(glob ? ["-g", glob] : []), "-e", pattern, target];
    let r = await exec("rg", rgArgs, ctx.config.workdir);
    if (r.code === 127 || r.spawnError) {
      const gArgs = ["-rnE", ...(ignore_case ? ["-i"] : []), ...(glob ? [`--include=${glob}`] : []), ...[...IGNORE].map((d) => `--exclude-dir=${d}`), "-e", pattern, target];
      r = await exec("grep", gArgs, ctx.config.workdir);
    }
    if (r.code === 1 && !r.stdout) return "no matches";
    const out = r.stdout.split(ctx.config.workdir + "/").join("");
    return truncate(out || r.stderr || "no matches");
  },
};

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string; spawnError?: boolean }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, timeout: timeoutMs });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", () => res({ code: 127, stdout, stderr, spawnError: true }));
    p.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}
