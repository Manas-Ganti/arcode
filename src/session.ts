import { appendFile, mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Message } from "./llm.js";

export interface Todo { content: string; status: "pending" | "in_progress" | "completed" }

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  workdir: string;
  model: string;
  task: string;
  status: "running" | "done" | "error" | "max_turns" | "interrupted";
  turns: number;
  usage: { prompt: number; completion: number };
  compactions: number;
}

/**
 * On-disk layout (one directory per session):
 *   meta.json         - summary + status
 *   messages.json     - the current (possibly compacted) context window
 *   trajectory.jsonl  - append-only event log; never compacted. RL/eval data source.
 *   todos.json, notes.md - task state, re-injected after compaction and on resume
 */
export class Session {
  messages: Message[] = [];
  todos: Todo[] = [];
  notes: string[] = [];
  private read = new Set<string>();

  private constructor(public dir: string, public meta: SessionMeta) {}

  static async create(dataDir: string, workdir: string, model: string, task: string): Promise<Session> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = `${ts}-${randomBytes(3).toString("hex")}`;
    const dir = join(dataDir, "sessions", id);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const s = new Session(dir, {
      id, createdAt: now, updatedAt: now, workdir, model, task,
      status: "running", turns: 0, usage: { prompt: 0, completion: 0 }, compactions: 0,
    });
    await s.save();
    await s.log({ type: "session_start", workdir, model, task });
    return s;
  }

  static async load(dataDir: string, id: string): Promise<Session> {
    const dir = join(dataDir, "sessions", id);
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as SessionMeta;
    const s = new Session(dir, meta);
    s.messages = JSON.parse(await readFile(join(dir, "messages.json"), "utf8"));
    s.todos = await readFile(join(dir, "todos.json"), "utf8").then(JSON.parse, () => []);
    s.notes = await readFile(join(dir, "notes.md"), "utf8").then((t) => t.split("\n").filter(Boolean).map((l) => l.replace(/^- /, "")), () => []);
    // Files read before the restart may have changed since; force a re-read before edits.
    return s;
  }

  /** Most recent session for this workdir, for `--continue`. */
  static async latest(dataDir: string, workdir: string): Promise<string | undefined> {
    const root = join(dataDir, "sessions");
    const ids = await readdir(root).catch(() => [] as string[]);
    for (const id of ids.sort().reverse()) {
      try {
        const meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")) as SessionMeta;
        if (meta.workdir === workdir) return id;
      } catch { /* skip broken */ }
    }
    return undefined;
  }

  static async list(dataDir: string): Promise<SessionMeta[]> {
    const root = join(dataDir, "sessions");
    const ids = await readdir(root).catch(() => [] as string[]);
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      try { metas.push(JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"))); } catch { /* skip */ }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  markRead(absPath: string) { this.read.add(absPath); }
  hasRead(absPath: string) { return this.read.has(absPath); }

  async setTodos(todos: Todo[]) {
    this.todos = todos;
    await writeFile(join(this.dir, "todos.json"), JSON.stringify(todos, null, 2));
    await this.log({ type: "todos", todos });
  }

  renderTodos(): string {
    if (!this.todos.length) return "(no plan)";
    const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    return this.todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
  }

  async addNote(text: string) {
    this.notes.push(text);
    await appendFile(join(this.dir, "notes.md"), `- ${text}\n`);
    await this.log({ type: "note", text });
  }

  /** Task state block injected into context after compaction / on resume. */
  stateBlock(): string {
    return [
      `<task_state>`,
      `Original task: ${this.meta.task}`,
      `Plan:\n${this.renderTodos()}`,
      `Notes:\n${this.notes.length ? this.notes.map((n) => `- ${n}`).join("\n") : "(none)"}`,
      `</task_state>`,
    ].join("\n");
  }

  async log(event: Record<string, unknown>) {
    await appendFile(join(this.dir, "trajectory.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  }

  async save() {
    this.meta.updatedAt = new Date().toISOString();
    await writeFile(join(this.dir, "meta.json"), JSON.stringify(this.meta, null, 2));
    await writeFile(join(this.dir, "messages.json"), JSON.stringify(this.messages));
  }
}

export async function exists(p: string) {
  return stat(p).then(() => true, () => false);
}
