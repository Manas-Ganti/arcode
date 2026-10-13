/**
 * Custom slash commands: saved prompts in markdown files.
 *   <workdir>/.arcode/commands/<name>.md   project commands (win on a name clash)
 *   $ARCODE_HOME/commands/<name>.md        personal commands (default ~/.arcode/commands)
 * `/name some args` sends the file's text with $ARGUMENTS replaced by "some args".
 * Optional frontmatter: ---\ndescription: one line shown by /commands\n---
 * Command files are only prompt text, so reading them from a project is safe:
 * whatever the prompt makes the agent do still goes through the approval prompts.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CustomCommand { name: string; description: string; body: string; path: string; scope: "project" | "user" }

/** Names the REPL handles itself; a command file can't shadow them. */
export const BUILTIN_COMMANDS = ["help", "plan", "notes", "session", "model", "compact", "commands", "exit", "quit"];

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export async function loadCommands(workdir: string, home: string): Promise<Map<string, CustomCommand>> {
  const found = new Map<string, CustomCommand>();
  // User first, then project, so project files win on a clash.
  for (const [dir, scope] of [[join(home, "commands"), "user"], [join(workdir, ".arcode", "commands"), "project"]] as const) {
    if (!existsSync(dir)) continue;
    for (const file of (await readdir(dir)).sort()) {
      const name = file.replace(/\.md$/, "");
      if (!file.endsWith(".md") || !NAME.test(name) || BUILTIN_COMMANDS.includes(name.toLowerCase())) continue;
      const path = join(dir, file);
      const { description, body } = parseCommandFile(await readFile(path, "utf8"));
      found.set(name.toLowerCase(), { name, description, body, path, scope });
    }
  }
  return found;
}

export function parseCommandFile(text: string): { description: string; body: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
  return { description: desc ?? body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80), body };
}

/** The prompt to send: $ARGUMENTS replaced, or the arguments appended if the file doesn't use it. */
export function expandCommand(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  return args ? `${body}\n\nArguments: ${args}` : body;
}

/** `/name rest of line` → { name, args }; undefined if the line isn't a slash command. */
export function parseSlash(line: string): { name: string; args: string } | undefined {
  const m = line.match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : undefined;
}

/** How a `!command` the user ran is shown to the model with their next message. */
export function shellContext(command: string, output: string, code: number | null): string {
  return `<user_shell_command>\n$ ${command}\n${output.trim()}\n[exit code ${code ?? "?"}]\n</user_shell_command>`;
}
