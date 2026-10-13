import type { Tool } from "./types.js";

/**
 * Task-state tools. The plan and notes live in the session directory and are
 * re-injected after every compaction, so the agent never loses track of what
 * it is doing even when old turns are summarized away.
 */

export const todoTool: Tool = {
  name: "todo_write",
  description:
    "Replace the task plan. Use at the start of any multi-step task and update as you go. Exactly one item should be in_progress at a time.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run({ todos }, ctx) {
    await ctx.session.setTodos(todos);
    return ctx.session.renderTodos();
  },
};

export const noteTool: Tool = {
  name: "note",
  description:
    "Save a durable fact about this task (a decision, a constraint, where something lives in the repo, a command that works). Notes survive context compaction and session resume.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run({ text }, ctx) {
    await ctx.session.addNote(text);
    return "noted";
  },
};
