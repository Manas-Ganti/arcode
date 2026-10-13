import type { ToolSpec } from "../llm.js";
import type { Tool } from "./types.js";
import { editFileTool, grepTool, listDirTool, readFileTool, writeFileTool } from "./fs.js";
import { bashTool } from "./shell.js";
import { webFetchTool, webSearchTool } from "./web.js";
import { noteTool, todoTool } from "./task.js";

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listDirTool,
  grepTool,
  bashTool,
  webSearchTool,
  webFetchTool,
  todoTool,
  noteTool,
];

export function toSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type { Tool, ToolContext } from "./types.js";
