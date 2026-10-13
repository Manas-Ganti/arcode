/**
 * Minimal MCP client (stdio transport, tools only). No dependencies.
 *
 * Config: $ARCODE_HOME/mcp.json (default ~/.arcode/mcp.json), the same shape
 * Claude Code / Claude Desktop use:
 *   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 * Read only from your home dir, never from a repo: each entry is a command arcode runs.
 *
 * Each server tool becomes an arcode tool named mcp__<server>__<tool>. Calls go
 * through the approval prompt unless the server marks the tool readOnlyHint.
 * Spec: modelcontextprotocol.io/specification/2025-11-25 (lifecycle, transports, tools).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Tool } from "./tools/types.js";
import { truncate } from "./tools/types.js";

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** arcode's own credentials are not passed to MCP servers (add them to a server's "env" if it needs one). */
const ARCODE_SECRETS = ["ARC_API_KEY", "VTARC_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY"];

export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; disabled?: boolean }
interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }

export function loadMcpConfig(home: string): Record<string, McpServerConfig> {
  const file = join(home, "mcp.json");
  if (!existsSync(file)) return {};
  const json = JSON.parse(readFileSync(file, "utf8"));
  return (json?.mcpServers ?? {}) as Record<string, McpServerConfig>;
}

/** One stdio server: JSON-RPC 2.0, one message per line. */
export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buf = "";
  private stderrTail: string[] = [];
  private exited?: string;

  constructor(public name: string, private cfg: McpServerConfig) {}

  async start(timeoutMs = 20_000): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.cfg.env };
    for (const k of ARCODE_SECRETS) if (!this.cfg.env?.[k]) delete env[k];
    this.proc = spawn(this.cfg.command!, this.cfg.args ?? [], { cwd: this.cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8").on("data", (d: string) => this.onData(d));
    this.proc.stderr!.setEncoding("utf8").on("data", (d: string) => {
      this.stderrTail.push(...d.split("\n").filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    this.proc.on("error", (e) => this.fail(`failed to start: ${e.message}`));
    this.proc.on("exit", (code, sig) => this.fail(`exited (${sig ?? `code ${code}`})${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : ""}`));

    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "arcode", version: "0.1.0" },
    }, timeoutMs);
    if (!SUPPORTED_VERSIONS.includes(init?.protocolVersion)) {
      this.close();
      throw new Error(`unsupported protocol version ${init?.protocolVersion}`);
    }
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: unknown, timeoutMs = 300_000): Promise<any> {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  close(): void {
    this.exited ??= "closed";
    this.proc?.stdin?.end();
    this.proc?.kill();
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error(`server ${this.exited}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private send(msg: object) {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; } // not a JSON-RPC message; ignore
      if (msg.id !== undefined && msg.method) {
        // Server → client request. arcode offers no client capabilities beyond ping.
        this.send(msg.method === "ping"
          ? { jsonrpc: "2.0", id: msg.id, result: {} }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `arcode does not support ${msg.method}` } });
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "error"} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      } // notifications (logging, list_changed) are ignored
    }
  }

  private fail(reason: string) {
    this.exited ??= reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`server ${reason}`));
      this.pending.delete(id);
    }
  }
}

/** An MCP tool result's content blocks → the string arcode tools return. */
export function flattenToolResult(result: any): string {
  const parts = (result?.content ?? []).map((b: any) => {
    switch (b?.type) {
      case "text": return b.text;
      case "image": case "audio": return `[${b.type}: ${b.mimeType ?? "unknown type"}, ${Math.round(((b.data?.length ?? 0) * 3) / 4)} bytes]`;
      case "resource_link": return `[resource: ${b.name ?? ""} ${b.uri}]`.replace("  ", " ");
      case "resource": return b.resource?.text ?? `[resource: ${b.resource?.uri} (${b.resource?.mimeType ?? "binary"})]`;
      default: return JSON.stringify(b);
    }
  });
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n").trim() || "(no output)";
  return result?.isError ? `error: ${text}` : text;
}

/** OpenAI function names allow [a-zA-Z0-9_-]{1,64}. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

export function toArcodeTool(client: McpClient, t: McpTool): Tool {
  const readOnly = t.annotations?.readOnlyHint === true;
  return {
    name: mcpToolName(client.name, t.name),
    description: `[MCP ${client.name}] ${t.description ?? t.name}`.slice(0, 1024),
    parameters: t.inputSchema?.type === "object" ? t.inputSchema : { type: "object", properties: {} },
    mutates: !readOnly,
    async run(args, ctx) {
      if (!readOnly && !(await ctx.approve(`mcp ${client.name}.${t.name}(${JSON.stringify(args).slice(0, 120)})`))) return "denied by user";
      try {
        return truncate(flattenToolResult(await client.callTool(t.name, args)));
      } catch (e: any) {
        return `error: MCP ${client.name}.${t.name} failed: ${e?.message ?? e}. The server may have crashed; try another approach.`;
      }
    },
  };
}

export interface McpSession { tools: Tool[]; status: string[]; close(): void }

/** Start every configured server in parallel. Failures are reported, never fatal. */
export async function startMcp(home: string): Promise<McpSession> {
  const servers = Object.entries(loadMcpConfig(home)).filter(([, c]) => !c.disabled);
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  const status: string[] = [];
  await Promise.all(servers.map(async ([name, cfg]) => {
    if (!cfg.command) {
      status.push(`${name}: skipped (${cfg.url ? "HTTP servers aren't supported yet" : "no command"})`);
      return;
    }
    const client = new McpClient(name, cfg);
    try {
      await client.start();
      const list = await client.listTools();
      clients.push(client);
      tools.push(...list.map((t) => toArcodeTool(client, t)));
      status.push(`${name}: ${list.length} tools`);
    } catch (e: any) {
      client.close();
      status.push(`${name}: failed (${e?.message ?? e})`);
    }
  }));
  return { tools, status: status.sort(), close: () => clients.forEach((c) => c.close()) };
}
