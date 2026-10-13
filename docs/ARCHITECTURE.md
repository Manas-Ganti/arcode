# arcode architecture

arcode is a small coding-agent harness: one loop you can read in a sitting, tools behind a single interface, and a session store that doubles as a trajectory dataset. The design goal is **usable daily, measurable always**.

## Layout

```
src/
  cli.ts        REPL + headless (-p) entry, approvals, rendering, resume
  agent.ts      the loop: build prompt → call model → run tools → repeat
  llm.ts        OpenAI-compatible client (raw fetch, SSE streaming, retries/backoff on 429/5xx)
  context.ts    token estimate + compaction (summarize middle, keep head/tail)
  session.ts    on-disk session: messages, trajectory, todos, notes
  config.ts     env-driven config (+ $ARCODE_HOME/.env)
  models.ts     per-model context window and request params, matched by id prefix
  tools/
    fs.ts       read_file, edit_file, write_file, list_dir, grep (workspace-confined)
    shell.ts    bash (timeout, output truncation, approval-gated)
    web.ts      web_search (Brave | Tavily | SearXNG), web_fetch (HTML→text)
    task.ts     todo_write, note (task state that survives compaction)
scripts/
  probe-arc.ts  verifies tool calling / reasoning fields per ARC model
  mock-e2e.ts   offline test against a scripted fake endpoint
```

## The loop (agent.ts)

1. If estimated context > budget, compact.
2. Call the model with all tool specs.
3. If the response has no structured `tool_calls`, try the `<tool_call>{…}</tool_call>` text fallback (for endpoints whose server isn't parsing tool calls).
4. Log the full response (including `reasoning_content`) to the trajectory, but strip `reasoning_content` from what's sent back next turn.
5. No tool calls means done. Otherwise run each tool, append results, save, loop.

Tool errors are returned to the model as text (`error: …`), never thrown, so the model can recover. Each tool returns a string; output is truncated head+tail at 20K chars.

## Context management

Three layers, from cheapest to most expensive:

| Layer | What | Survives compaction | Survives resume |
|---|---|---|---|
| Recent turns | last ~10 messages verbatim | yes | yes |
| Task state | `todo_write` plan + `note` facts, re-injected as `<task_state>` | yes | yes |
| Summary | model-written compression of older turns | replaces them | yes |

Compaction never splits an assistant tool call from its tool results (APIs reject orphaned `tool` messages). `trajectory.jsonl` is append-only and never compacted, so the full history is always on disk.

Edit safety: `edit_file` and overwriting `write_file` require the file was `read_file`'d in this process. After resume, that set is empty, which forces a re-read of possibly stale files.

## Session store

`~/.arcode/sessions/<timestamp>-<rand>/`

- `meta.json`: task, model, status (`done | error | max_turns | interrupted`), turns, token usage, compactions
- `messages.json`: the current context window (what gets resumed)
- `trajectory.jsonl`: one event per line: `session_start`, `user`, `llm_call` (full message, usage, latency, finish reason, context size), `tool` (name, args, ok, ms, output), `todos`, `note`, `compaction`, `error`
- `todos.json`, `notes.md`

The trajectory format is the research hook. Every run, interactive or benchmark, becomes (state, action, observation) data with outcome metadata.

## Safety model

- File tools are confined to the workspace root (path traversal rejected).
- `bash`, `write_file`, and `edit_file` go through an approval prompt unless `--yes`.
- Headless without `--yes` denies all side effects.
- **`bash` is not a sandbox.** For benchmark runs on untrusted repos, run arcode inside a container (Docker/Apptainer on ARC) and use `--yes` there.

## Roadmap

Ordered by expected impact on usefulness and on research value.

**Usability**
1. ~~Streaming responses (SSE) so long generations aren't silent.~~ Done: agent turns stream (also avoids ARC's 8000 max_tokens cap on non-streamed requests); compaction stays non-streamed.
2. Repo map: a tree-sitter or ctags symbol index injected at session start, so the model doesn't spend turns on `list_dir`.
3. Diff preview on edit approvals, plus `git` checkpoint/undo per task.
4. Ink-based TUI (status bar with model, tokens, plan) once the core stabilizes.
5. MCP client so external tool servers plug in without code changes.

**Evaluation / research**
6. `arcode eval`: a headless runner over SWE-bench Lite/Verified-style tasks in containers, writing `results.jsonl` with pass/fail per instance.
7. Model comparison report: GLM vs DeepSeek on the same task set (resolve rate, turns, tokens, tool error rate).
8. Trajectory exporter to chat-format SFT data and to (prompt, completion, reward) tuples for GRPO-style training.
9. Ablations: compaction on/off, todo tool on/off, text-fallback vs native tool calls.

**Robustness**
10. Exact token counts via the endpoint's `usage` instead of the char estimate.
11. A per-model quirks table (tool-call format, reasoning field names, max context) filled from `npm run probe`. Started in `models.ts`; context windows there are still unverified.
